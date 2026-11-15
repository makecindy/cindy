/**
 * 证书签名请求(PKCS#10 CSR)的最小 DER 编码:只含一个名字(域名或 IP)与 ECDSA P-256 公钥。
 * node:crypto 能生成密钥和签名,但不能生成 CSR;为一个结构引入整套 ASN.1 库不值得。
 */
import { createPublicKey, sign, type KeyObject } from 'node:crypto';
import { isIP, isIPv4, isIPv6 } from 'node:net';

export interface CertificateIdentifier {
  type: 'ip' | 'dns';
  value: string;
}

/** 访问地址是 IP 时签 IP 证书,否则签域名证书。 */
export function identifierFor(address: string): CertificateIdentifier {
  return isIP(address) ? { type: 'ip', value: address } : { type: 'dns', value: address.toLowerCase() };
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);

function objectId(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const value of rest) {
    const chunk: number[] = [value & 0x7f];
    for (let n = value >> 7; n > 0; n >>= 7) chunk.unshift(0x80 | (n & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function ipBytes(address: string): Buffer {
  if (isIPv4(address)) return Buffer.from(address.split('.').map(Number));
  if (!isIPv6(address)) throw new Error('invalid IP address');
  const [head, tail] = address.includes('::') ? address.split('::') : [address, undefined];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const groups = [...headParts, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...tailParts];
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => out.writeUInt16BE(parseInt(group || '0', 16), index * 2));
  return out;
}

const OID_COMMON_NAME = '2.5.4.3';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14';
const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';

/** 用证书私钥(ECDSA P-256)签出 DER 编码的 CSR。 */
export function buildCsr(privateKey: KeyObject, identifier: CertificateIdentifier): Buffer {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  // IP 证书不带 CN(CA 会忽略或拒绝);域名证书 CN 与 SAN 一致。
  const subject =
    identifier.type === 'dns'
      ? sequence(set(sequence(objectId(OID_COMMON_NAME), tlv(0x0c, Buffer.from(identifier.value, 'utf8')))))
      : sequence();
  const generalName =
    identifier.type === 'ip' ? tlv(0x87, ipBytes(identifier.value)) : tlv(0x82, Buffer.from(identifier.value, 'ascii'));
  const subjectAltName = sequence(objectId(OID_SUBJECT_ALT_NAME), tlv(0x04, sequence(generalName)));
  const extensionRequest = sequence(objectId(OID_EXTENSION_REQUEST), set(sequence(subjectAltName)));
  const info = sequence(tlv(0x02, Buffer.from([0])), subject, spki, tlv(0xa0, extensionRequest));
  const signature = sign('sha256', info, privateKey);
  return sequence(info, sequence(objectId(OID_ECDSA_WITH_SHA256)), tlv(0x03, Buffer.from([0]), signature));
}
