import {
  IncomingResponse as IncomingResponseMessage,
  OutgoingRequest as OutgoingRequestMessage
} from "../../SIPMessage";
import { Dialog, InviteDialog } from "../dialogs";
import {
  Body,
  OutgoingAckRequest,
  OutgoingInviteRequest,
  OutgoingInviteRequestDelegate,
  OutgoingPrackRequest,
  RequestOptions
} from "../messages";
import { InviteClientTransaction } from "../transactions";
import { UserAgentCore } from "../user-agent-core";
import { UserAgentClient } from "./user-agent-client";

/**
 * 13 Initiating a Session
 * https://tools.ietf.org/html/rfc3261#section-13
 * 13.1 Overview
 * https://tools.ietf.org/html/rfc3261#section-13.1
 * 13.2 UAC Processing
 * https://tools.ietf.org/html/rfc3261#section-13.2
 */
export class InviteUserAgentClient extends UserAgentClient implements OutgoingInviteRequest {
  public delegate: OutgoingInviteRequestDelegate | undefined;

  private confirmedDialogAcks = new Map<string, OutgoingAckRequest>();
  private confirmedDialogs = new Map<string, InviteDialog>();
  private earlyDialogs = new Map<string, InviteDialog>();

  constructor(
    protected core: UserAgentCore,
    message: OutgoingRequestMessage,
    delegate?: OutgoingInviteRequestDelegate
  ) {
    super(InviteClientTransaction, core, message, delegate);
    this.delegate = delegate;
    // FIXME: HACK: This is a hack to override OutgoingRequest.cancel().
    // The plan is to remove OutgoingRequest.cancel() eventually, but for now
    // it effectively short circuits calls to request.cancel() for this request.
    this.message.cancel = (reason?: string, extraHeaders?: Array<string>): void => {
      this.cancel(reason, { extraHeaders });
    };
  }

  public dispose(): void {
    // The UAC core considers the INVITE transaction completed 64*T1 seconds
    // after the reception of the first 2xx response.  At this point all the
    // early dialogs that have not transitioned to established dialogs are
    // terminated.  Once the INVITE transaction is considered completed by
    // the UAC core, no more new 2xx responses are expected to arrive.
    //
    // If, after acknowledging any 2xx response to an INVITE, the UAC does
    // not want to continue with that dialog, then the UAC MUST terminate
    // the dialog by sending a BYE request as described in Section 15.
    // https://tools.ietf.org/html/rfc3261#section-13.2.2.4
    this.earlyDialogs.forEach((earlyDialog) => earlyDialog.dispose());
    this.earlyDialogs.clear();
    super.dispose();
  }

  /**
   * Once the INVITE has been passed to the INVITE client transaction, the
   * UAC waits for responses for the INVITE.
   * https://tools.ietf.org/html/rfc3261#section-13.2.2
   * @param incomingResponse Incoming response to INVITE request.
   */
  protected receiveResponse(message: IncomingResponseMessage): void {
    if (!this.authenticationGuard(message)) {
      return;
    }

    const statusCode = message.statusCode ? message.statusCode.toString() : "";
    if (!statusCode) {
      throw new Error("Response status code undefined.");
    }

    switch (true) {
      case /^100$/.test(statusCode):
        if (this.delegate && this.delegate.onTrying) {
          this.delegate.onTrying({ message });
        }
        return;
      case /^1[0-9]{2}$/.test(statusCode):
        // Zero, one or multiple provisional responses may arrive before one or
        // more final responses are received.  Provisional responses for an
        // INVITE request can create "early dialogs".  If a provisional response
        // has a tag in the To field, and if the dialog ID of the response does
        // not match an existing dialog, one is constructed using the procedures
        // defined in Section 12.1.2.
        //
        // The early dialog will only be needed if the UAC needs to send a
        // request to its peer within the dialog before the initial INVITE
        // transaction completes.  Header fields present in a provisional
        // response are applicable as long as the dialog is in the early state
        // (for example, an Allow header field in a provisional response
        // contains the methods that can be used in the dialog while this is in
        // the early state).
        // https://tools.ietf.org/html/rfc3261#section-13.2.2.1
        {
          // Provisional without to tag, no dialog to create.
          if (!message.toTag) {
            this.logger.warn("Non-100 1xx INVITE response received without a to tag, dropping.");
            return;
          }

          // Compute dialog state.
          const dialogState = Dialog.initialDialogStateForUserAgentClient(this.message, message);

          // Have existing early dialog or create a new one.
          let earlyDialog = this.earlyDialogs.get(dialogState.id);
          if (!earlyDialog) {
            const transaction = this.transaction;
            if (!(transaction instanceof InviteClientTransaction)) {
              throw new Error("Transaction not instance of InviteClientTransaction.");
            }
            earlyDialog = new InviteDialog(transaction, this.core, dialogState);
            this.earlyDialogs.set(earlyDialog.id, earlyDialog);
          }

          // Guard against out of order reliable provisional responses.
          // Note that this is where the rseq tracking is done.
          if (!earlyDialog.reliableSequenceGuard(message)) {
            this.logger.warn("1xx INVITE reliable response received out of order, dropping.");
            return;
          }

          // Update dialog signaling state if need be.
          earlyDialog.signalingStateTransition(message);

          // Pass response to delegate.
          const session = earlyDialog;
          if (this.delegate && this.delegate.onProgress) {
            this.delegate.onProgress({
              message,
              session,
              prack: (options?: RequestOptions): OutgoingPrackRequest => {
                const outgoingPrackRequest = session.prack(undefined, options);
                return outgoingPrackRequest;
              }
            });
          }
        }
        return;
      case /^2[0-9]{2}$/.test(statusCode):
        // Multiple 2xx responses may arrive at the UAC for a single INVITE
        // request due to a forking proxy.  Each response is distinguished by
        // the tag parameter in the To header field, and each represents a
        // distinct dialog, with a distinct dialog identifier.
        //
        // If the dialog identifier in the 2xx response matches the dialog
        // identifier of an existing dialog, the dialog MUST be transitioned to
        // the "confirmed" state, and the route set for the dialog MUST be
        // recomputed based on the 2xx response using the procedures of Section
        // 12.2.1.2.  Otherwise, a new dialog in the "confirmed" state MUST be
        // constructed using the procedures of Section 12.1.2.
        // https://tools.ietf.org/html/rfc3261#section-13.2.2.4
        {
          // Compute dialog state.
          const dialogState = Dialog.initialDialogStateForUserAgentClient(this.message, message);

          // NOTE: Currently our transaction layer is caching the 2xx ACKs and
          // handling retransmissions of the ACK which is an approach which is
          // not to spec. In any event, this block is intended to provide a to
          // spec implementation of ACK retransmissions, but it should not be
          // hit currently.
          let dialog = this.confirmedDialogs.get(dialogState.id);
          if (dialog) {
            // Once the ACK has been constructed, the procedures of [4] are used to
            // determine the destination address, port and transport.  However, the
            // request is passed to the transport layer directly for transmission,
            // rather than a client transaction.  This is because the UAC core
            // handles retransmissions of the ACK, not the transaction layer.  The
            // ACK MUST be passed to the client transport every time a
            // retransmission of the 2xx final response that triggered the ACK
            // arrives.
            // https://tools.ietf.org/html/rfc3261#section-13.2.2.4
            const outgoingAckRequest = this.confirmedDialogAcks.get(dialogState.id);
            if (outgoingAckRequest) {
              const transaction = this.transaction;
              if (!(transaction instanceof InviteClientTransaction)) {
                throw new Error("Client transaction not instance of InviteClientTransaction.");
              }
              transaction.ackResponse(outgoingAckRequest.message);
            } else {
              // If still waiting for an ACK, drop the retransmission of the 2xx final response.
            }
            return;
          }

          // If the dialog identifier in the 2xx response matches the dialog
          // identifier of an existing dialog, the dialog MUST be transitioned to
          // the "confirmed" state, and the route set for the dialog MUST be
          // recomputed based on the 2xx response using the procedures of Section
          // 12.2.1.2. Otherwise, a new dialog in the "confirmed" state MUST be
          // constructed using the procedures of Section 12.1.2.
          // https://tools.ietf.org/html/rfc3261#section-13.2.2.4
          dialog = this.earlyDialogs.get(dialogState.id);
          if (dialog) {
            dialog.confirm();
            dialog.recomputeRouteSet(message);
            this.earlyDialogs.delete(dialog.id);
            this.confirmedDialogs.set(dialog.id, dialog);
          } else {
            const transaction = this.transaction;
            if (!(transaction instanceof InviteClientTransaction)) {
              throw new Error("Transaction not instance of InviteClientTransaction.");
            }
            dialog = new InviteDialog(transaction, this.core, dialogState);
            this.confirmedDialogs.set(dialog.id, dialog);
          }

          // Update dialog signaling state if need be.
          dialog.signalingStateTransition(message);

          // Session Initiated! :)
          const session = dialog;

          // FIXME: HACK: This is a hack to override IncomingResponse.ack().
          // The plan is to remove IncomingResponse.ack() eventually, but for now
          // it effectively short circuits calls to response.ack() for this response.
          if (this.delegate && this.delegate.onAccept) {
            message.ack = (
              options: {
                extraHeaders?: Array<string>,
                body?: string | { body: string, contentType: string }
              } = {}
            ): OutgoingRequestMessage => {
              let body: Body | undefined;
              if (options.body) {
                if (typeof options.body === "string") {
                  body = {
                    content: options.body,
                    contentType: "application/sdp",
                    contentDisposition: "session"
                  };
                } else {
                  body = {
                    content: options.body.body,
                    contentType: options.body.contentType,
                    contentDisposition: "session"
                  };
                }
              }
              const outgoingAckRequest = session.ack({ extraHeaders: options.extraHeaders, body });
              this.confirmedDialogAcks.set(session.id, outgoingAckRequest);
              return outgoingAckRequest.message;
            };
          }

          // The UAC core MUST generate an ACK request for each 2xx received from
          // the transaction layer.  The header fields of the ACK are constructed
          // in the same way as for any request sent within a dialog (see Section
          // 12) with the exception of the CSeq and the header fields related to
          // authentication.  The sequence number of the CSeq header field MUST be
          // the same as the INVITE being acknowledged, but the CSeq method MUST
          // be ACK.  The ACK MUST contain the same credentials as the INVITE.  If
          // the 2xx contains an offer (based on the rules above), the ACK MUST
          // carry an answer in its body.  If the offer in the 2xx response is not
          // acceptable, the UAC core MUST generate a valid answer in the ACK and
          // then send a BYE immediately.
          // https://tools.ietf.org/html/rfc3261#section-13.2.2.4
          if (this.delegate && this.delegate.onAccept) {
            this.delegate.onAccept({
              message,
              session,
              ack: (options?: RequestOptions): OutgoingAckRequest => {
                const outgoingAckRequest = session.ack(options);
                this.confirmedDialogAcks.set(session.id, outgoingAckRequest);
                return outgoingAckRequest;
              }
            });
          } else {
            const outgoingAckRequest = session.ack();
            this.confirmedDialogAcks.set(session.id, outgoingAckRequest);
          }
        }
        return;
      case /^3[0-9]{2}$/.test(statusCode):
        // 12.3 Termination of a Dialog
        //
        // Independent of the method, if a request outside of a dialog generates
        // a non-2xx final response, any early dialogs created through
        // provisional responses to that request are terminated.  The mechanism
        // for terminating confirmed dialogs is method specific.  In this
        // specification, the BYE method terminates a session and the dialog
        // associated with it.  See Section 15 for details.
        // https://tools.ietf.org/html/rfc3261#section-12.3

        // All early dialogs are considered terminated upon reception of the
        // non-2xx final response.
        //
        // After having received the non-2xx final response the UAC core
        // considers the INVITE transaction completed.  The INVITE client
        // transaction handles the generation of ACKs for the response (see
        // Section 17).
        // https://tools.ietf.org/html/rfc3261#section-13.2.2.3
        this.earlyDialogs.forEach((earlyDialog) => earlyDialog.dispose());
        this.earlyDialogs.clear();

        // A 3xx response may contain one or more Contact header field values
        // providing new addresses where the callee might be reachable.
        // Depending on the status code of the 3xx response (see Section 21.3),
        // the UAC MAY choose to try those new addresses.
        // https://tools.ietf.org/html/rfc3261#section-13.2.2.2
        if (this.delegate && this.delegate.onRedirect) {
          this.delegate.onRedirect({ message });
        }
        return;
      case /^[4-6][0-9]{2}$/.test(statusCode):
        // 12.3 Termination of a Dialog
        //
        // Independent of the method, if a request outside of a dialog generates
        // a non-2xx final response, any early dialogs created through
        // provisional responses to that request are terminated.  The mechanism
        // for terminating confirmed dialogs is method specific.  In this
        // specification, the BYE method terminates a session and the dialog
        // associated with it.  See Section 15 for details.
        // https://tools.ietf.org/html/rfc3261#section-12.3

        // All early dialogs are considered terminated upon reception of the
        // non-2xx final response.
        //
        // After having received the non-2xx final response the UAC core
        // considers the INVITE transaction completed.  The INVITE client
        // transaction handles the generation of ACKs for the response (see
        // Section 17).
        // https://tools.ietf.org/html/rfc3261#section-13.2.2.3
        this.earlyDialogs.forEach((earlyDialog) => earlyDialog.dispose());
        this.earlyDialogs.clear();

        // A single non-2xx final response may be received for the INVITE.  4xx,
        // 5xx and 6xx responses may contain a Contact header field value
        // indicating the location where additional information about the error
        // can be found.  Subsequent final responses (which would only arrive
        // under error conditions) MUST be ignored.
        // https://tools.ietf.org/html/rfc3261#section-13.2.2.3
        if (this.delegate && this.delegate.onReject) {
          this.delegate.onReject({ message });
        }
        return;
      default:
        throw new Error(`Invalid status code ${statusCode}`);
    }

    throw new Error(`Executing what should be an unreachable code path receiving ${statusCode} response.`);
  }
}
