import { describe, expect, it } from 'vitest';
import {
  INPUT_HANDOFF_ENDED_PREFIX,
  UI_ACTION_TRIGGER_PREFIX,
  inputHandoffRecordHost,
  inputHandoffRecordMessage,
  parseInputHandoffEndRecord,
} from '../syntheticTrigger.js';

const line = (facts: string) => `${UI_ACTION_TRIGGER_PREFIX}${INPUT_HANDOFF_ENDED_PREFIX} ${facts}. Continue.`;

describe('代输入 record line', () => {
  it('reads the facts the Host wrote and nothing else', () => {
    const record = parseInputHandoffEndRecord(
      line('status=succeeded steps=2 origin=https://login.example.test/sso app="Example App" answered_on="Chris \\"Phone\\""'),
    );
    expect(record).toEqual({
      status: 'succeeded',
      nothingToFill: false,
      steps: 2,
      origin: 'https://login.example.test/sso',
      app: 'Example App',
      answeredOn: { kind: 'named', name: 'Chris "Phone"' },
    });
    expect(inputHandoffRecordHost(record!.origin)).toBe('login.example.test');
  });

  it('labels where it was finished', () => {
    const msg = (facts: string) => inputHandoffRecordMessage(parseInputHandoffEndRecord(line(facts))!);
    expect(msg('status=succeeded steps=1 answered_on=this_computer')).toEqual({ key: 'doneHost', params: { count: 1 } });
    expect(msg('status=succeeded steps=3 answered_on=phone')).toEqual({ key: 'donePhone', params: { count: 3 } });
    expect(msg('status=succeeded steps=1 answered_on=another_device')).toEqual({ key: 'doneElsewhere', params: { count: 1 } });
    expect(msg('status=succeeded steps=0').key).toBe('done');
    expect(msg('status=cancelled steps=0 ended_by=detected failure=nothing_to_fill').key).toBe('nothingToFill');
    expect(msg('status=cancelled steps=1').key).toBe('cancelled');
    expect(msg('status=expired steps=0').key).toBe('expired');
    expect(msg('status=failed steps=0').key).toBe('failed');
  });

  it('ignores other hidden triggers and malformed lines', () => {
    expect(parseInputHandoffEndRecord(`${UI_ACTION_TRIGGER_PREFIX}Something else`)).toBeNull();
    expect(parseInputHandoffEndRecord(line('status=weird steps=1'))).toBeNull();
    expect(inputHandoffRecordHost('not a url')).toBeUndefined();
  });
});
