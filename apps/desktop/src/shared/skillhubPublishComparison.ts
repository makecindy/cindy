/** Local comparison state; hashes never represent permission or package authenticity. */
export interface SkillhubContentChange {
  path: string;
  kind: 'added' | 'removed' | 'modified';
  isBinary: boolean;
  oldContent: string;
  newContent: string;
  oldSize: number;
  newSize: number;
}

export interface SkillhubPublishComparisonParams {
  absolutePath: string;
  skillId?: string;
  includeDiff?: boolean;
}

export type SkillhubPublishComparison =
  | { status: 'not-owner' }
  | { status: 'unavailable'; /** Only confirmed transport, rate-limit or server failures affect other skills. */ reason?: 'service' }
  | {
      status: 'same' | 'different';
      version: string;
      pending: boolean;
      /** When an installed copy differs from the compared release, distinguish
       * local edits from an unchanged older installation. Omitted by older clients. */
      localChanges?: 'modified' | 'unchanged' | 'unknown';
      changes?: SkillhubContentChange[];
    };
