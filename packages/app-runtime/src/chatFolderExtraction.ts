import { createReadStream, promises as fs } from "node:fs";
import { extractDirectoryArchive } from "./directoryArchive.js";
export async function extractChatFolder(archive: string): Promise<string> {
  const destination = `${archive}.contents`;
  await fs.mkdir(destination);
  try {
    if (
      await extractDirectoryArchive(createReadStream(archive), destination, {
        confineSymlinks: true,
      })
    )
      throw new Error("INCOMPLETE_FOLDER");
    return destination;
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
