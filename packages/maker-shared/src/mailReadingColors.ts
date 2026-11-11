export type MailReadingPalette = { surface: string; text: string };

/** Keep the sender's hue instead of mixing almost all of it into the app
 * surface. This pure function also runs in the native mail WebView. */
export function mailReadingColor(color: string, role: 'background' | 'text', palette: MailReadingPalette): string {
  const parts = color.match(/^rgba?\(([^)]+)\)/)?.[1].split(/[, /]+/).map(Number);
  if (!parts || parts.length < 3 || parts[3] === 0) return color;
  const [r, g, b] = parts.map(value => value / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const brightness = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const neutral = delta <= 16 / 255;
  if (role === 'text') {
    if (brightness >= 0.72) return color;
    return neutral ? palette.text : `color-mix(in srgb, ${palette.text} 80%, ${color})`;
  }
  if (brightness <= 0.25) return color;
  if (neutral) return palette.surface;
  const originalLightness = (max + min) / 2;
  const saturation = Math.min(0.8, delta / (1 - Math.abs(2 * originalLightness - 1)));
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  if (hue < 0) hue += 6;
  const lightness = Math.min(originalLightness, 0.28);
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(hue % 2 - 1)), m = lightness - chroma / 2;
  const channels = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x]
    : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const rgb = channels.map(value => Math.round((value + m) * 255));
  return `rgba(${rgb.join(', ')}, ${parts[3] ?? 1})`;
}

/** Trusted native injection only: no mail-authored scripts or bridges are enabled.
 * Restore before repainting so theme switches never accumulate dimming. */
export function mailReadingThemeScript(dark: boolean, palette: MailReadingPalette): string {
  return `(function(){
    var marker='data-cindy-mail-reading-style';
    var nodes=Array.from(document.querySelectorAll('html,body,body *')).filter(function(el){return el.tagName!=='IMG'});
    nodes.forEach(function(el){
      if(!el.hasAttribute(marker))return;
      var style=JSON.parse(el.getAttribute(marker));
      if(style===null)el.removeAttribute('style');else el.setAttribute('style',style);
      el.removeAttribute(marker);
    });
    if(!${JSON.stringify(dark)})return;
    // Keep this source literal: native Hermes does not retain Function.toString source.
    var recolor=function(color,role,palette){
      var match=color.match(/^rgba?\\(([^)]+)\\)/);
      var parts=match?match[1].split(/[, /]+/).map(Number):null;
      if(!parts||parts.length<3||parts[3]===0)return color;
      var r=parts[0]/255,g=parts[1]/255,b=parts[2]/255;
      var max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
      var brightness=r*0.2126+g*0.7152+b*0.0722,neutral=delta<=16/255;
      if(role==='text')return brightness>=0.72?color:neutral?palette.text:'color-mix(in srgb, '+palette.text+' 80%, '+color+')';
      if(brightness<=0.25)return color;if(neutral)return palette.surface;
      var originalLightness=(max+min)/2,saturation=Math.min(0.8,delta/(1-Math.abs(2*originalLightness-1)));
      var hue=max===r?((g-b)/delta)%6:max===g?(b-r)/delta+2:(r-g)/delta+4;if(hue<0)hue+=6;
      var lightness=Math.min(originalLightness,0.28),chroma=(1-Math.abs(2*lightness-1))*saturation;
      var x=chroma*(1-Math.abs(hue%2-1)),m=lightness-chroma/2;
      var channels=hue<1?[chroma,x,0]:hue<2?[x,chroma,0]:hue<3?[0,chroma,x]:hue<4?[0,x,chroma]:hue<5?[x,0,chroma]:[chroma,0,x];
      return 'rgba('+channels.map(function(value){return Math.round((value+m)*255)}).join(', ')+', '+(parts[3]===undefined?1:parts[3])+')';
    };
    var palette=${JSON.stringify(palette)};
    var authored=nodes.map(function(el){var css=getComputedStyle(el);return {el:el,style:el.getAttribute('style'),background:css.backgroundColor,color:css.color,borders:['Top','Right','Bottom','Left'].map(function(side){return css['border'+side+'Color']})}});
    authored.forEach(function(item){
      var el=item.el;el.setAttribute(marker,JSON.stringify(item.style));
      // CSS gradients must not remain bright behind the adapted light text.
      el.style.setProperty('background-image','none','important');
      el.style.setProperty('background-color',recolor(item.background,'background',palette),'important');
      el.style.setProperty('color',recolor(item.color,'text',palette),'important');
      ['top','right','bottom','left'].forEach(function(side,i){el.style.setProperty('border-'+side+'-color',recolor(item.borders[i],'background',palette),'important')});
    });
    document.documentElement.style.setProperty('color-scheme','dark','important');
    document.documentElement.style.setProperty('background-color',palette.surface,'important');
  })();true;`;
}
