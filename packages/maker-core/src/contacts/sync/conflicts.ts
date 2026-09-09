import { createHash } from "node:crypto";

import { compareContactsSyncText } from "./merge.js";
import {
  type ContactsSyncEntity,
  type ContactsSyncIdentityValue,
  type ContactsSyncState,
} from "./types.js";

export interface ContactsIdentityConflict {
  platform: string;
  normalizedValue: string;
  owners: Set<string>;
  membershipHash: string;
}

export function collectContactsIdentityConflicts(
  state: ContactsSyncState,
): ContactsIdentityConflict[] {
  const contactIds = new Set(
    state.contacts
      .filter((contact) => !contact.deleted)
      .map((contact) => contact.id),
  );
  const recordsByKey = new Map<
    string,
    Array<ContactsSyncEntity<ContactsSyncIdentityValue>>
  >();
  for (const record of state.identities) {
    if (record.deleted || !contactIds.has(record.value.value.contactId))
      continue;
    const value = record.value.value;
    const key = `${value.platform}\u0000${value.normalizedValue}`;
    const records = recordsByKey.get(key) ?? [];
    records.push(record);
    recordsByKey.set(key, records);
  }

  const conflicts: ContactsIdentityConflict[] = [];
  for (const [key, records] of recordsByKey) {
    const owners = new Set(
      records.map((record) => record.value.value.contactId),
    );
    if (owners.size <= 1) continue;
    const first = records[0]!.value.value;
    const membershipHash = createHash("sha256")
      .update(
        JSON.stringify(
          [...owners].sort(compareContactsSyncText),
        ),
      )
      .digest("hex");
    conflicts.push({
      platform: first.platform,
      normalizedValue: first.normalizedValue,
      owners,
      membershipHash,
    });
  }
  return conflicts.sort((left, right) =>
    compareContactsSyncText(
      `${left.platform}\u0000${left.normalizedValue}`,
      `${right.platform}\u0000${right.normalizedValue}`,
    ),
  );
}
