// `qrcode` ships no type declarations. Only the one call the pairing card makes is declared here,
// so a second (types-only) dependency is not needed and the surface we rely on stays explicit.
declare module 'qrcode' {
  export type QRCodeToDataURLOptions = {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    width?: number;
    color?: { dark?: string; light?: string };
  };
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  const QRCode: { toDataURL: typeof toDataURL };
  export default QRCode;
}
