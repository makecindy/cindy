import { describe, expect, it } from 'vitest';

import { PluginProtocolError as DeliveryPluginProtocolError } from '@cindy/plugin-protocol/delivery';
import {
  PluginProtocolError as MemberUploadPluginProtocolError,
  parsePluginMemberUploadStatusResponse,
} from '@cindy/plugin-protocol/member-upload';

describe('member-upload public subpath', () => {
  it('re-exports the shared PluginProtocolError class identity', () => {
    expect(MemberUploadPluginProtocolError).toBe(DeliveryPluginProtocolError);

    expect(() => parsePluginMemberUploadStatusResponse(null)).toThrow(
      MemberUploadPluginProtocolError,
    );
  });
});
