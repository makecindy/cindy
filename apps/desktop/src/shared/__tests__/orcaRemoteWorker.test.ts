import { describe, expect, it } from 'vitest';

import { parseOrcaRemoteLead, serializeOrcaRemoteLead } from '../orcaRemoteWorker';

const lead = {
  leadDeviceId: 'dev-xdpc',
  leadDeviceName: 'XD-PC',
  leadSessionId: 'lead-1',
  leadTitle: '整理产品访谈报告',
  workerLabel: '转写',
};

describe('orca remote lead marker', () => {
  it('round-trips through the stored JSON', () => {
    expect(parseOrcaRemoteLead(serializeOrcaRemoteLead(lead))).toEqual(lead);
    expect(parseOrcaRemoteLead(serializeOrcaRemoteLead({ ...lead, releasedAt: 5 }))).toEqual({
      ...lead,
      releasedAt: 5,
    });
  });

  it('treats missing, corrupt or incomplete values as a normal task', () => {
    expect(parseOrcaRemoteLead(null)).toBeNull();
    expect(parseOrcaRemoteLead('{not json')).toBeNull();
    expect(parseOrcaRemoteLead('[]')).toBeNull();
    expect(parseOrcaRemoteLead({ ...lead, leadDeviceId: undefined })).toBeNull();
    expect(parseOrcaRemoteLead({ ...lead, workerLabel: 'x'.repeat(33) })).toBeNull();
  });

  it('fills optional display text and drops invalid release stamps', () => {
    expect(
      parseOrcaRemoteLead({
        leadDeviceId: 'dev-xdpc',
        leadSessionId: 'lead-1',
        workerLabel: '转写',
        releasedAt: 'soon',
      }),
    ).toEqual({
      leadDeviceId: 'dev-xdpc',
      leadDeviceName: '',
      leadSessionId: 'lead-1',
      leadTitle: '',
      workerLabel: '转写',
    });
  });
});
