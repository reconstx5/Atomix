// Cast v2 messages: the one protobuf message the protocol uses (CastMessage), hand-encoded, and the 4-byte
// big-endian length framing around it on the TLS stream.
//
//   message CastMessage {
//     required ProtocolVersion protocol_version = 1;  // 0 = CASTV2_1_0
//     required string source_id = 2;
//     required string destination_id = 3;
//     required string namespace = 4;
//     required PayloadType payload_type = 5;          // 0 = STRING
//     optional string payload_utf8 = 6;
//     optional bytes payload_binary = 7;
//   }

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}
const key = (field, wire) => varint((field << 3) | wire);
const str = (field, s) => {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([key(field, 2), varint(b.length), b]);
};

/** @returns {Buffer} the framed message: length, then the protobuf */
export function encodeCastMessage({ sourceId, destinationId, namespace, payload }) {
  const body = Buffer.concat([key(1, 0), varint(0), str(2, sourceId), str(3, destinationId), str(4, namespace), key(5, 0), varint(0), str(6, payload)]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
  }
}

/** @param {Buffer} buf the protobuf (no length prefix) */
export function decodeCastMessage(buf) {
  const out = { sourceId: '', destinationId: '', namespace: '', payload: '' };
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      [, pos] = readVarint(buf, pos);
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const value = buf.subarray(pos, pos + len);
      pos += len;
      if (field === 2) out.sourceId = value.toString('utf8');
      else if (field === 3) out.destinationId = value.toString('utf8');
      else if (field === 4) out.namespace = value.toString('utf8');
      else if (field === 6) out.payload = value.toString('utf8');
      else if (field === 7) out.payloadBinary = Buffer.from(value);
    } else if (wire === 5) pos += 4;
    else if (wire === 1) pos += 8;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

/** Turns TLS chunks into whole messages, however the stream splits or joins them. */
export class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  /** @returns {object[]} the decoded messages completed by this chunk */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 64 * 1024 * 1024) throw new Error('cast message too large');
      if (this.buf.length < 4 + len) break;
      out.push(decodeCastMessage(this.buf.subarray(4, 4 + len)));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}
