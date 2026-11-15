import { mountPage } from '../../ui-page/harness';
import { MailHtmlPreview } from '../../../src/renderer/components/chat/MailHtmlPreview';

// Structural reproduction of an indented HTML ticket, without private mail data.
const ticket = `<html><head><style>
body{margin:0;background:white;font-family:Arial,sans-serif}
.card{width:100%;max-width:600px;margin:auto;background:#f99a3c}
.address{padding:20px 55px;text-align:left}
.address p{margin:0;line-height:28px;font-size:17px;color:black}
@media(max-width:400px){.address{padding:20px 25px}}
</style></head><body>
<table class="card" cellspacing="0" cellpadding="0"><tr><td>
<h1 style="text-align:center;color:black;font-size:28px;padding:24px">Your event ticket</h1>
<div style="margin:20px;padding:20px;background:white;color:#333;border-radius:10px">
<strong style="font-size:28px">47 EXAMPLE</strong><p style="margin:8px 0 0;font-size:24px">104/194</p></div>
<div class="address"><p><strong>
                          SAMPLE
                      </strong></p><p>
                          Alex
                      </p><p>
                          28 Example Road
                      </p><p>
                          Example City
                      </p></div>
<p style="text-align:center;padding:20px;color:black">Keep this ticket for your visit.</p>
<p class="gradient" style="padding:20px;background:linear-gradient(#fff,#eee);color:black">Read this notice on a gradient.</p>
</td></tr></table></body></html>`;

void mountPage({ render: ctx => <main className="min-h-screen p-3">
  <MailHtmlPreview reading value={ctx.case === 'fixed-width'
    ? '<table style="width:800px;min-width:800px"><tr><td>Left edge</td><td style="text-align:right">Right edge</td></tr></table>'
    : ticket} />
</main> });
