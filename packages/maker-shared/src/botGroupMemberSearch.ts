import { match, pinyin } from 'pinyin-pro';
import type { BotGroupMemberView } from './botGroupChat.js';

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

/** Build search terms for this roster only. Results keep the original member identity. */
export function createBotGroupMemberSearch(
  members: readonly BotGroupMemberView[],
  directoryLabel?: (member: BotGroupMemberView) => string,
) {
  const roster = members.map(member => ({
    member,
    name: normalize(directoryLabel ? directoryLabel(member) : member.name),
    // The directory also supports literal searches by original name and organization.
    details: directoryLabel
      ? [member.name, member.displayName, member.orgName, member.department, member.departmentPath]
          .flatMap(value => value ? [normalize(value)] : [])
      : [],
  }));
  const pinyinByName = new Map<string, readonly string[]>();

  function matchesPinyin(name: string, needle: string): boolean {
    if (!/\p{Script=Han}/u.test(name)) return false;
    let terms = pinyinByName.get(name);
    if (!terms) {
      const syllables = pinyin(name, {
        type: 'array', toneType: 'none', surname: 'head', v: true, nonZh: 'consecutive',
      });
      terms = [syllables.join(''), syllables.map(syllable => syllable[0] ?? '').join('')];
      pinyinByName.set(name, terms);
    }
    // The converted terms cover substrings inside syllables. The matcher also
    // finds alternative readings and lets full syllables and initials coexist.
    return terms.some(term => term.includes(needle)) ||
      match(name, needle, { continuous: true, precision: 'start' }) !== null;
  }

  return (query: string): BotGroupMemberView[] => {
    const needle = normalize(query);
    if (!needle) return [...members];
    const phoneticNeedle = needle.replaceAll('ü', 'v');
    const searchPinyin = /^[a-z]+$/.test(phoneticNeedle);
    const exact: BotGroupMemberView[] = [];
    const prefix: BotGroupMemberView[] = [];
    const inner: BotGroupMemberView[] = [];
    const phonetic: BotGroupMemberView[] = [];
    const directoryMatches: BotGroupMemberView[] = [];
    for (const { member, name, details } of roster) {
      if (name === needle) exact.push(member);
      else if (name.startsWith(needle)) prefix.push(member);
      else if (name.includes(needle)) inner.push(member);
      else if (searchPinyin && matchesPinyin(name, phoneticNeedle)) phonetic.push(member);
      else if (details.some(value => value.includes(needle))) directoryMatches.push(member);
    }
    return [...exact, ...prefix, ...inner, ...phonetic, ...directoryMatches];
  };
}
