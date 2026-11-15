import { useEffect, useState } from 'react';
import { ghostCardRecipients } from '@cindy/maker-shared/ghost-card-form';
import { mailParticipantEmail, type MailMessage } from '@cindy/maker-shared/mail-message';

const maxMailAvatars = 12;

/** Count positions, including duplicates, so all header rows share one budget. */
export function mailAvatarLimits(mail: Pick<MailMessage, 'from' | 'to' | 'cc' | 'bcc'>) {
  let remaining = maxMailAvatars;
  const limits = { from: 0, to: 0, cc: 0, bcc: 0 };
  for (const key of ['from', 'to', 'cc', 'bcc'] as const) {
    limits[key] = remaining ? Math.min(remaining, ghostCardRecipients(mail[key]).length) : 0;
    remaining -= limits[key];
  }
  return limits;
}

// A mailbox provider's logo is not the identity of everyone using its service.
const publicMailDomains = new Set(('gmail.com googlemail.com outlook.com hotmail.com live.com msn.com ' +
  'icloud.com me.com mac.com yahoo.com yahoo.co.uk yahoo.co.jp ymail.com rocketmail.com aol.com ' +
  'qq.com foxmail.com 163.com 126.com yeah.net sina.com sina.cn sohu.com aliyun.com ' +
  'proton.me protonmail.com pm.me tutanota.com tuta.com fastmail.com hey.com mail.com gmx.com gmx.net web.de').split(' '));

function domainIcon(email: string): string | undefined {
  const domain = email.split('@')[1];
  if (!domain || publicMailDomains.has(domain) || /^(yahoo|hotmail|outlook|live|gmx)\./.test(domain) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(domain) || /\.{2}|^-|-$|\.-|-\./.test(domain)) return undefined;
  // Fixed public image origin: never contact a sender-controlled website directly.
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

function Avatar({ email, label, photo, compact }: { email?: string; label: string; photo?: string; compact: boolean }) {
  const [publicPhoto, setPublicPhoto] = useState<string>();
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string>();
  const contact = photo && !failed.includes(photo) ? photo : undefined;
  useEffect(() => {
    if (!email || contact) return;
    let active = true;
    // Gravatar receives only the normalized email hash, never the raw address.
    void Promise.resolve().then(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))).then(bytes => {
      const hash = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
      if (active) setPublicPhoto(`https://gravatar.com/avatar/${hash}?s=64&d=404&r=g`);
    }).catch(() => { if (active) setPublicPhoto(''); });
    return () => { active = false; };
  }, [email, contact]);
  const domain = email ? domainIcon(email) : undefined;
  const src = contact || (publicPhoto && !failed.includes(publicPhoto) ? publicPhoto :
    publicPhoto !== undefined && domain && !failed.includes(domain) ? domain : undefined);
  useEffect(() => {
    if (!src || loaded === src) return;
    const timer = setTimeout(() => setFailed(previous => [...previous, src]), 4000);
    return () => clearTimeout(timer);
  }, [src, loaded]);
  const initials = Array.from(label.replace(/^[\s"']+/, '')).slice(0, 1).join('').toUpperCase() || '?';
  return <span aria-hidden="true" className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-muted text-muted-foreground ${compact ? 'h-5 w-5 text-11' : 'h-8 w-8 text-13'} ${src === domain && domain ? 'rounded-md' : 'rounded-full'}`}>
    {initials}
    {src && <img key={src} src={src} alt="" referrerPolicy="no-referrer" draggable={false}
      className={`absolute inset-0 h-full w-full ${src === domain ? 'object-contain p-0.5' : 'object-cover'} ${loaded === src ? '' : 'invisible'}`}
      onLoad={() => setLoaded(src)} onError={() => setFailed(previous => [...previous, src])} />}
  </span>;
}

/** Shared sender/recipient presentation; the full address remains visible on hover. */
export function MailParticipants({ value, photos, compact = true, avatarLimit = maxMailAvatars }: {
  value: string; photos?: MailMessage['participantPhotos']; compact?: boolean; avatarLimit?: number;
}) {
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
    {ghostCardRecipients(value).map(({ address, label }, index) => {
      const email = mailParticipantEmail(address);
      const avatarEmail = index < avatarLimit ? email : undefined;
      const photo = avatarEmail ? photos?.find(item => item.email === avatarEmail)?.url : undefined;
      return <span key={`${address}:${index}`} title={address} className="inline-flex min-w-0 max-w-full items-center gap-1.5">
        <Avatar key={`${avatarEmail}:${photo}`} email={avatarEmail} label={label} photo={photo} compact={compact} />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{compact ? address : label}
          {!compact && email && email !== label && <span className="block text-12 font-normal text-muted-foreground">{email}</span>}
        </span>
      </span>;
    })}
  </span>;
}
