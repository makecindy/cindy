import Bonjour, { type Service, type Browser } from 'bonjour-service';
import { randomBytes } from 'node:crypto';
import type { LanDiscovery } from './lan.js';
/** DNS-SD interop with iOS Bonjour / Android NSD. Public, short-lived signed
 * beacons use the same verifier as the original UDP discovery protocol. */
export class BonjourDiscovery {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;
  private browser: Browser | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private refreshing = false;
  private readonly name = 'cindy-' + randomBytes(12).toString('hex');
  constructor(private readonly lan: LanDiscovery, private readonly port: number) {}
  start(): void {
    if (this.bonjour || this.closed) return;
    try {
      const bonjour = this.bonjour = new Bonjour({}, () => this.close());
      const receive = (service: Service) => {
        if (this.closed || !service.txt || !service.addresses || Object.keys(service.txt).length > 8) return;
        const parts: string[] = [];
        for (let i = 0; i < 8 && service.txt['b' + i] !== undefined; i++) {
          const value = service.txt['b' + i];
          if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) return;
          parts.push(value);
        }
        const bytes = Buffer.from(parts.join(''), 'base64url');
        if (!bytes.length || bytes.length > 1024) return;
        try { if (JSON.parse(bytes.toString('utf8')).port !== service.port) return; } catch { return; }
        for (const address of service.addresses.slice(0, 16)) this.lan.receive(bytes, address);
      };
      this.browser = bonjour.find({ type: 'cindy-agentnet', protocol: 'udp' }, receive);
      this.browser.on('txt-update', receive);
      this.browser.on('srv-update', receive);
      this.publish();
      this.timer = setInterval(() => this.publish(), 5000); this.timer.unref();
    } catch { this.close(); }
  }
  private publish(): void {
    if (this.closed || !this.bonjour || this.refreshing) return;
    this.refreshing = true;
    const previous = this.service; this.service = null;
    const publish = () => {
      this.refreshing = false;
      if (this.closed || !this.bonjour) return;
      const text = Buffer.from(this.lan.beacon()).toString('base64url'), txt: Record<string, string> = {};
      for (let i = 0; i * 200 < text.length; i++) txt['b' + i] = text.slice(i * 200, (i + 1) * 200);
      const service = this.service = this.bonjour.publish({ name: this.name, host: this.name + '.local',
        type: 'cindy-agentnet', protocol: 'udp', port: this.port, txt, probe: false, disableIPv6: true });
      service.on('error', () => this.close());
    };
    if (previous) { previous.stop(() => { previous.destroyed = true; publish(); }); } else publish();
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    this.browser?.stop(); this.browser = null;
    if (this.service) this.service.destroyed = true;
    this.service = null;
    this.bonjour?.destroy(); this.bonjour = null;
  }
}
