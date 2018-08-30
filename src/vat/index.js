// this file is evaluated in the SES realm and defines the Vat. It gets two
// endowments: 'module' (used to export everything) and 'log' (which wraps
// console.log). Both of these come from the primal realm, so they must not
// be exposed to guest code.

import { makeWebkeyMarshal, doSwissHashing } from './webkey';
import { isVow, asVow, Flow, Vow, makePresence } from '../flow/flowcomm';
import { resolutionOf, handlerOf } from '../flow/flowcomm'; // todo unclean
import { makeRemoteManager } from './remotes';
import { makeResolutionNotifier } from './notifyUponResolution';

const msgre = /^msg: (\w+)->(\w+) (.*)$/;

function confineGuestSource(source, endowments) {
  endowments = endowments || {};
  const exports = {};
  const module = { exports };
  function guestLog(...args) {
    log(...args);
  }
  const endow = { module, exports, log: guestLog };
  if (endowments) {
    Object.defineProperties(endow,
                            Object.getOwnPropertyDescriptors(endowments));
  }
  SES.confine(source, endow);
  return module.exports;
}

export function makeVat(endowments, myVatID, initialSource) {

  // We have one serializer/deserializer for each locally-hosted Vat, so
  // it shared among all peer Vats.

  // A FarVow (specifically a Vow in the 'far' state) can be used to send
  // remote messages: v.e.foo(1,2) will queue an invocation of
  // target.foo(1,2) on whatever target object the vow eventually resolves
  // to. Each Vow (including FarVows) have their own identity: creating two
  // (resolved) Vows from the same object will yield entirely different Vows.
  // So if you have two Vows and want to ask if they point at the same thing,
  // you must use .then(), wait for the callback to fire with a Presence,
  // then compare the Presences instead. This callback will fire on a
  // subsequent turn without doing network IO, since FarVows are already
  // resolved (unlike RemoteVows or LocalVows).

  // A Presence represents a specific remote object (on a specific Vat). You
  // get one by calling .then() on a some Vow (other than a NearVow, which
  // will resolve to local object, or a BrokenVow, which resolves to an
  // error), and then waiting until the callback fires. Presences can be
  // compared for EQ, but you can't send messages on them. To send messages,
  // turn the Presence into a FarVow by using Vow.resolve(p) .

  // Vow states:
  // * near: resolved, points to a local object
  // * far: resolved, points to an object on some other vat
  // * local: unresolved, no idea what it will resolve to
  // * remote: unresolved, but some other vat has a LocalVow that is a better
  //   place to queue messages than us
  // * broken

  // Vow transfers:
  // * sending a pass-by-reference object results in a Presence. Sending that
  //   Presence elsewhere results in another Presence. Sending a Presence to
  //   its home vat results in the original object reference (EQ to the
  //   starting point)
  // * sending a NearVow results in a FarVow. Sending that FarVow elsewhere
  //   results in another FarVow. Sending a FarVow to its home vat results in
  //   a new NearVow (not EQ to the original): using .then() on both will
  //   yield the same object.
  // * sending a LocalVow results in a RemoteVow. Sending that RemoteVow
  //   elsewhere is currently an error. Sending that RemoteVow to its home
  //   vat is currently an error. (ideally sending it elsewhere yields a
  //   RemoteVow, and sending it back home results in the original LocalVow,
  //   but it isn't clear how hard this might be)

  // When sending a NearVow, the comms layer will need to know the resolution
  // object, so it can assign a swissnum that can be used by the receiving
  // side to build a Presence that points to the same object. This will
  // always occur in the context of an outbound message, when the FarHandler
  // delivers the (op, args) event to the comms layer. We put an extra
  // argument into this function call to give the comms layer a way to ask
  // about NearVow->object mappings.


  // We currently define three operations: Send(targetID, op, args,
  // resolverID), SendOnly(targetID, op, args), and Resolve(resolverID, val).

  // Each side of a pairwise comms connection maintains a "resolution table",
  // mapping a resolutionID to a Resolver that should be invoked upon receipt
  // of a Resolve() operation. In practice there will be one table for the
  // whole comms layer, but it is indexed by (peerVatID, resolutionID).
  // Inbound Resolve() operations *from* VatA may only access rows with
  // peerVatID==VatA. This requires the transport layer to reliably indicate
  // the origin of an inbound connection.

  // When an object in VatA does y = b.foo(), y is a new LocalVow created by
  // the comms layer (ish). The comms layer allocates a random unguessable
  // resolverID and puts the new resolver into the resolution table, and
  // includes the resolverID in the Send() operation. The receiver
  // deserializes the arguments, looks up the target, invokes the named
  // operation, and inspects the result. If the result is an immediate value,
  // it sends (really it queues until after checkpoint) a Resolve() operation
  // with the resolverID and value. If the result is a Promise, it attaches a
  // .then() callback to do the same.

  // if an object in VatA has a LocalVow 'x' (todo: maybe of any type) and
  // includes it as an argument like b.foo(x), then the comms layer assigns a
  // new swissnum (if 'x' has not been sent anywhere before). It attaches a
  // .then() callback to the object, so when that fires in the future, it
  // sends a Resolve(swissnum, val) operation to the remote side. When the
  // receiver deserializes the argument into a RemoteVow, it adds the
  // swissnum into its resolution table.

  // The resolution table thus contains rows allocated by the local side
  // (when sending a resolver, in the specific case of a message-send that is
  // not a SendOnly), and rows allocated by the far side (when receiving a
  // RemoteVow).

  const manager = makeRemoteManager();
  const notifyUponResolution = makeResolutionNotifier(log, myVatID, opResolve);

  let inTurn = false;

  function startTurn() {
    inTurn = true;
    //endowments.writeOutput(`turn-begin`);
  }

  function finishTurn() {
    inTurn = false;
    //endowments.writeOutput(`turn-end`);
  }

  // todo: queue this until finishTurn
  function opSend(resultSwissbase, targetVatID, targetSwissnum, methodName, args,
                  resolutionOf) {
    const seqnum = manager.nextOutboundSeqnum(targetVatID);
    const bodyJson = marshal.serialize(def({seqnum,
                                            op: 'send',
                                            resultSwissbase,
                                            targetSwissnum,
                                            methodName,
                                            args,
                                           }),
                                       resolutionOf,
                                       targetVatID);
    endowments.writeOutput(`msg: ${myVatID}->${targetVatID} ${bodyJson}\n`);
    manager.sendTo(targetVatID, bodyJson);
  }

  function opResolve(targetVatID, targetSwissnum, value) {
    log('opResolve', targetVatID, targetSwissnum, value);
    const seqnum = manager.nextOutboundSeqnum(targetVatID);
    const bodyJson = marshal.serialize(def({seqnum,
                                            op: 'resolve',
                                            targetSwissnum,
                                            value,
                                           }),
                                       resolutionOf,
                                       targetVatID);
    endowments.writeOutput(`msg: ${myVatID}->${targetVatID} ${bodyJson}\n`);
    manager.sendTo(targetVatID, bodyJson);
  }

  function allocateSwissStuff() {
    return marshal.allocateSwissStuff();
  }

  function registerRemoteVow(vatID, swissnum, resultVow) {
    marshal.registerRemoteVow(vatID, swissnum, resultVow);
  }

  const serializer = {
    startTurn, finishTurn, opSend, opResolve, notifyUponResolution,
    allocateSwissStuff, registerRemoteVow,
  };

  const ext = Vow.resolve(makePresence(serializer, 'v2', 'swiss1'));

  const marshal = makeWebkeyMarshal(myVatID, serializer);
  // marshal.serialize, unserialize, serializeToWebkey, unserializeWebkey

  function doSendInternal(body) {
    const target = marshal.getMyTargetBySwissnum(body.targetSwissnum);
    if (!target) {
      throw new Error(`unrecognized target swissnum ${body.targetSwissnum}`);
    }
    // todo: sometimes causes turn delay, could fastpath if target is
    // resolved
    return Vow.resolve(target).e[body.methodName](...body.args);
  }

  // This is the host's interface to the Vat. It must act as a sort of
  // airlock: host objects passed into these functions should not be exposed
  // to other code, to avoid accidentally exposing primal-realm
  // Object/Function/etc.

  function deliverMessage(senderVatID, message) {
    serializer.startTurn();
    const { body, bodyJson } = message;
    endowments.writeOutput(`msg ${senderVatID}->${myVatID} ${bodyJson}`);
    log(`op ${body.op}`);
    let done;
    if (body.op === 'send') {
      const res = doSendInternal(body);
      if (body.resultSwissbase) {
        const resolverSwissnum = doSwissHashing(body.resultSwissbase);
        // registerTarget arranges to notify senderVatID when this resolves
        marshal.registerTarget(res, resolverSwissnum, senderVatID, resolutionOf);
        // note: BrokenVow is pass-by-copy, so Vow.resolve(rej) causes a BrokenVow
      } else {
        // else it was really a sendOnly
        log(`commsReceived got sendOnly, dropping result`);
      }
      done = res; // for testing
    } else if (body.op === `resolve`) {
      const h = marshal.getOutboundResolver(senderVatID, body.targetSwissnum, handlerOf);
      //log(`h: ${h}`);
      h.resolve(body.value);
    }
    // todo: when should we commit/release? after all promises created by
    // opSend have settled?
    serializer.finishTurn();
    return done; // for testing, to wait until things are done
  }

  function commsReceived(senderVatID, bodyJson) {
    senderVatID = `${senderVatID}`;
    bodyJson = `${bodyJson}`;
    log(`commsReceived ${senderVatID}, ${bodyJson}`);
    const body = marshal.unserialize(bodyJson);
    if (body.op === 'ack') {
      manager.ackOutbound(senderVatID, body.ackSeqnum);
      return;
    }
    if (body.seqnum === undefined) {
      throw new Error(`message is missing seqnum: ${bodyJson}`);
    }
    manager.queueInbound(senderVatID, body.seqnum, { body, bodyJson });
    manager.processInboundQueue(senderVatID, deliverMessage, marshal);
  }

  function buildSturdyRef(vatID, swissnum) {
    return `${vatID}/${swissnum}`;
  }

  return {
    check() {
      log('yes check');
    },

    makeEmptyObject() {
      return {};
    },

    createPresence(sturdyref) {
      return marshal.createPresence(sturdyref);
    },

    async initializeCode(rootSturdyRef, argv) {
      const refParts = rootSturdyRef.split('/');
      const refVatID = refParts[0];
      const rootSwissnum = refParts[1];
      if (refParts[0] !== myVatID) {
        throw new Error(`vatID mismatch:\n${myVatID} is my vatID, but saved rootSturdyRef uses\n${refVatID}`);
      }
      //endowments.writeOutput(`load: ${initialSourceHash}`);
      // the top-level code executes now, during evaluation
      const e = confineGuestSource(initialSource,
                                   { isVow, asVow, Flow, Vow,
                                     ext
                                   }).default;
      // then we execute whatever was exported as the 'default'
      const root = await Vow.resolve().then(_ => e(argv));
      // we wait for that to resolve before executing the transcript
      if (root) {
        // we register this, but nobody is waiting on it yet, so we don't
        // have to tell registerTarget a vat to notify when it resolves
        marshal.registerTarget(root, rootSwissnum, null, resolutionOf);
      }
      return root; // for testing
    },

    whatConnectionsDoYouWant() {
      return manager.whatConnectionsDoYouWant();
    },

    connectionMade(vatID, connection) {
      log(`connectionMade for ${vatID}`);
      const c = {
        send(msg) {
          connection.send(msg);
        }
      };
      manager.gotConnection(`${vatID}`, c, marshal);
    },

    connectionLost(vatID) {
      manager.lostConnection(`${vatID}`);
    },

    serialize(val, targetVatID) {
      return marshal.serialize(val, resolutionOf, targetVatID);
    },

    doSendOnly(bodyJson) {
      const body = marshal.unserialize(bodyJson);
      return doSendInternal(body);
    },

    executeTranscriptLine(line) {
      log(`executeTranscriptLine '${line}'`);
      if (line === '') {
        //log(`empty line`);
        return;
      }
      if (line.startsWith('load: ')) {
        const arg = /^load: (\w+)$/.exec(line)[1];
        //      if (arg !== initialSourceHash) {
        //        throw Error(`err: input says to load ${arg}, but we loaded ${initialSourceHash}`);
        //      }
        log(`load matches, good`);
      } else if (line.startsWith('msg: ')) {
        const m = msgre.exec(line);
        const fromVat = m[1];
        const toVat = m[2];
        const bodyJson = m[3];
        log(`transcript msg ${fromVat} ${toVat} (i am ${myVatID})`);
        if (toVat === myVatID) {
          //endowments.writeOutput(line);
          commsReceived(fromVat, bodyJson);
        }
      } else {
        log(`unknown line: ${line}`);
      }
    },

    deliverMessage,
    commsReceived,

    /*
    sendReceived(op, sourceVatID, resultSwissbase) {
      // returns a promise
      log(`sendReceived ${op}`);
      const result = processOp(op);
      Vow.resolve(result).then(r => serializer.sendResolve(sourceVatID, resultSwissnum, marshal.serialize(r)));
      let resolver;
      const p = f.makeVow((resolve, reject) => resolver = resolve);
      processOp(op, resolver);
      return p;
    }*/
  };
}

