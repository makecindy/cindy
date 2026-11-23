import alipay from '../../assets/billing/alipay.svg';
import alipayHK from '../../assets/billing/alipayhk.svg';

// Official wallet artwork from https://acceptance-mark.alipayplus.com/ (Single Asset).
export function AlipayIcon({ hongKong }: { hongKong: boolean }) {
  return (
    <img src={hongKong ? alipayHK : alipay} alt="" width={20} height={20} className="shrink-0" />
  );
}
