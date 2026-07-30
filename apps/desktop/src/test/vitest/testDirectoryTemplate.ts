import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Builds an immutable temporary directory once and gives every test a private
 * copy. Real-Git suites use this to avoid repeating git init/config/seed commits
 * in every beforeEach while preserving isolated repository state per test.
 */
export class TestDirectoryTemplate {
  private templatePromise: Promise<string> | null = null;
  private readonly prefix: string;
  private readonly initialize: (directory: string) => Promise<void>;

  constructor(
    prefix: string,
    initialize: (directory: string) => Promise<void>,
  ) {
    this.prefix = prefix;
    this.initialize = initialize;
  }

  async createCopy(): Promise<string> {
    const templatePath = await this.getOrCreateTemplate();
    const copyPath = await fs.mkdtemp(path.join(os.tmpdir(), this.prefix));
    try {
      await fs.cp(templatePath, copyPath, { recursive: true });
      return copyPath;
    } catch (error) {
      await fs.rm(copyPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const pending = this.templatePromise;
    this.templatePromise = null;
    if (!pending) return;
    const templatePath = await pending;
    await fs.rm(templatePath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }

  private getOrCreateTemplate(): Promise<string> {
    this.templatePromise ??= this.createTemplate();
    return this.templatePromise;
  }

  private async createTemplate(): Promise<string> {
    const templatePath = await fs.mkdtemp(path.join(os.tmpdir(), `${this.prefix}template-`));
    try {
      await this.initialize(templatePath);
      return templatePath;
    } catch (error) {
      await fs.rm(templatePath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      throw error;
    }
  }
}
