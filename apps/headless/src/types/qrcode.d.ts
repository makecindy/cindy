declare module 'qrcode' {
  interface TerminalOptions {
    type: 'terminal';
    small?: boolean;
  }

  const QRCode: {
    toString(text: string, options: TerminalOptions): Promise<string>;
  };

  export default QRCode;
}
