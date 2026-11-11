import { AudioLines, Brain, Clock3, FolderOpen, History, Info, MessageCircle, Settings2, Sparkles, UserRound, type LucideIcon } from 'lucide-react';

/** One icon per teammate-settings entry; the settings list and the Bot Market detail modules draw from this table. */
export const botSettingsIcons = {
  profile: Info,
  personality: UserRound,
  memory: Brain,
  projects: FolderOpen,
  model: Sparkles,
  voice: AudioLines,
  capabilities: Settings2,
  channels: MessageCircle,
  routines: Clock3,
  history: History,
  advanced: FolderOpen,
} satisfies Record<string, LucideIcon>;
