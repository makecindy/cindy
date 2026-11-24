// @vitest-environment jsdom
/**
 * Test value (#10568): verifies WorkspacePathField drive badge extraction, compact path display,
 * inline copy/open actions, and full/linked path popover presentation. Unit tier; jsdom.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractDriveBadge,
  formatCompactPath,
  WorkspacePathField,
} from '../WorkspacePathField';

afterEach(() => {
  cleanup();
});

describe('WorkspacePathField helpers', () => {
  it('extracts uppercase Windows drive badges and ignores POSIX paths', () => {
    expect(extractDriveBadge('d:\\Cindy\\workspaces\\bot-1')).toBe('D:');
    expect(extractDriveBadge('C:/Users/Alice/Cindy')).toBe('C:');
    expect(extractDriveBadge('/Users/alice/Cindy/workspaces')).toBeNull();
    expect(extractDriveBadge('\\\\server\\share\\bot')).toBeNull();
  });

  it('compacts deeply nested paths to the leading anchor and last three segments', () => {
    expect(
      formatCompactPath('D:\\Cindy-QA\\default-root\\buddy-workspaces\\owner1\\bot-1-workspace'),
    ).toBe('…\\buddy-workspaces\\owner1\\bot-1-workspace');
    expect(formatCompactPath('D:\\CindyWorkspaces\\bot-1-workspace')).toBe(
      'CindyWorkspaces\\bot-1-workspace',
    );
    expect(formatCompactPath('/Users/alice/Library/Cindy/bots/bot-1/workspace')).toBe(
      'Users/…/bots/bot-1/workspace',
    );
  });
});

describe('WorkspacePathField component', () => {
  it('renders drive badge, triggers inline copy and open, and reveals linked path in popover', async () => {
    const onCopy = vi.fn();
    const onOpen = vi.fn();
    render(
      <WorkspacePathField
        path="D:\CindyWorkspaces\bot-1-workspace"
        linkedPath="C:\Users\Alice\AppData\Roaming\Cindy\owners\o1\bots\bot-1\workspace"
        linkedPathLabel="Original linked path"
        fullPathLabel="Full path"
        primaryPathLabel="Target folder"
        copyLabel="Copy path"
        openLabel="Open folder"
        onCopy={onCopy}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByText('D:')).toBeTruthy();
    expect(screen.getByText('CindyWorkspaces\\bot-1-workspace')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(onCopy).toHaveBeenCalledWith('D:\\CindyWorkspaces\\bot-1-workspace');

    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Full path' }));
    expect(await screen.findByText('Target folder')).toBeTruthy();
    expect(
      screen.getByText('C:\\Users\\Alice\\AppData\\Roaming\\Cindy\\owners\\o1\\bots\\bot-1\\workspace'),
    ).toBeTruthy();
  });
});
