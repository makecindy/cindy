import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { SPEAKER_GATE_STRICTNESS_VALUES } from '@cindy/voice-input-core';
import { VOICE_INPUT_EXTRA_LANGUAGES } from '../../../shared/voiceInputData';
import { defineSettings, type SettingsSearchContext, type SettingsSearchModule } from './settingsSearchTypes';

const isByokVisible = ({ mode, voiceInput }: SettingsSearchContext) =>
  Boolean(voiceInput && (mode === 'local' || voiceInput.serviceMode === 'byok'));
const isCustomAsrVisible = (context: SettingsSearchContext) =>
  isByokVisible(context) && context.voiceInput?.asrProvider === 'custom-realtime-asr';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const voiceInputSettings = defineSettings({
  voiceInput: {
    id: 'voiceInput',
    tab: 'voice-input',
    targetId: 'settings-panel-voice-input',
    titleKey: TAB_LABEL_KEY['voice-input'],
    sectionKey: 'settings.sections.voiceInput',
  },
  languageLabel: {
    id: 'settings.voiceInput.language.label',
    fallbackTargetId: 'settings-panel-voice-input',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-language-label',
    titleKey: 'settings.voiceInput.language.label',
    sectionKey: 'settings.tabs.voiceInput',
    descriptionKey: 'settings.voiceInput.language.hint',
    options: (
      ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', ...VOICE_INPUT_EXTRA_LANGUAGES] as const
    ).map((value) => ({
      value,
      labelKey:
        value === 'auto' || (VOICE_INPUT_EXTRA_LANGUAGES as readonly string[]).includes(value)
          ? `settings.voiceInput.language.options.${value}`
          : `settings.language.options.${value}`,
      descriptionKey: `settings.voiceInput.language.optionDescriptions.${value}`,
    })),
  },
  microphoneLabel: {
    id: 'settings.voiceInput.microphone.label',
    fallbackTargetId: 'settings-panel-voice-input',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-microphone-label',
    titleKey: 'settings.voiceInput.microphone.label',
    sectionKey: 'settings.tabs.voiceInput',
    descriptionKey: 'settings.voiceInput.microphone.hint',
  },
  refinementEnabledLabel: {
    id: 'settings.voiceInput.refinement.enabled.label',
    fallbackTargetId: 'settings-panel-voice-input',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-refinement-enabled-label',
    titleKey: 'settings.voiceInput.refinement.enabled.label',
    sectionKey: 'settings.tabs.voiceInput',
    descriptionKey: 'settings.voiceInput.refinement.enabled.hint',
  },
  refinementInstructionsLabel: {
    isVisible: ({ voiceRefinementEnabled }) => voiceRefinementEnabled === true,
    id: 'settings.voiceInput.refinement.instructions.label',
    fallbackTargetId: 'settings-search-settings-voiceInput-refinement-enabled-label',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-refinement-instructions-label',
    titleKey: 'settings.voiceInput.refinement.instructions.label',
    sectionKey: 'settings.tabs.voiceInput',
    descriptionKey: 'settings.voiceInput.refinement.instructions.hint',
  },
  refinementDictionaryLabel: {
    isVisible: ({ voiceRefinementEnabled }) => voiceRefinementEnabled === true,
    id: 'settings.voiceInput.refinement.dictionary.label',
    fallbackTargetId: 'settings-search-settings-voiceInput-refinement-enabled-label',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-refinement-dictionary-label',
    titleKey: 'settings.voiceInput.refinement.dictionary.label',
    sectionKey: 'settings.tabs.voiceInput',
    descriptionKey: 'settings.voiceInput.refinement.dictionary.hint',
  },
  muteSystemAudioLabel: {
    id: 'settings.voiceInput.muteSystemAudio.label',
    fallbackTargetId: 'settings-panel-voice-input',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-muteSystemAudio-label',
    titleKey: 'settings.voiceInput.muteSystemAudio.label',
    sectionKey: 'settings.tabs.voiceInput',
    descriptionKey: 'settings.voiceInput.muteSystemAudio.hint',
    isVisible: ({ platform }) => platform === 'darwin' || platform === 'win32',
  },
  interactionSoundLabel: {
    id: 'settings.voiceInput.interactionSound.label',
    fallbackTargetId: 'settings-panel-voice-input',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-interactionSound-label',
    titleKey: 'settings.voiceInput.interactionSound.label',
    sectionKey: 'settings.tabs.voiceInput',
    descriptionKey: 'settings.voiceInput.interactionSound.hint',
  },
  historyLabel: {
    id: 'settings.voiceInput.history.label',
    fallbackTargetId: 'settings-panel-voice-input',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-history-label',
    titleKey: 'settings.voiceInput.history.label',
    sectionKey: 'settings.tabs.voiceInput',
  },
  sectionsUsageData: {
    id: 'settings.voiceInput.sections.usageData',
    fallbackTargetId: 'settings-panel-voice-input',
    tab: 'voice-input',
    targetId: 'settings-search-voice-usage-data',
    titleKey: 'settings.voiceInput.sections.usageData',
    sectionKey: 'settings.tabs.voiceInput',
  },
  fastActivationLabel: {
    id: 'settings.voiceInput.fastActivation.label',
    fallbackTargetId: 'settings-panel-voice-input',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-fastActivation-label',
    titleKey: 'settings.voiceInput.fastActivation.label',
    sectionKey: 'settings.tabs.voiceInput',
    descriptionKey: 'settings.voiceInput.fastActivation.hint',
  },
  speakerFilterLabel: {
    id: 'settings.voiceInput.speakerFilter.label',
    fallbackTargetId: 'settings-panel-voice-input',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-speakerFilter-label',
    titleKey: 'settings.voiceInput.speakerFilter.label',
    sectionKey: 'settings.tabs.voiceInput',
    descriptionKey: 'settings.voiceInput.speakerFilter.hint',
    descriptionKeyForContext: ({ speakerFilter }) => speakerFilter?.supported === false
      ? 'settings.voiceInput.speakerFilter.unsupported' : undefined,
    options: [
      {
        value: 'strictness',
        labelKey: 'settings.voiceInput.speakerFilter.strictness.label',
        descriptionKey: 'settings.voiceInput.speakerFilter.strictness.hint',
      },
      ...SPEAKER_GATE_STRICTNESS_VALUES.map((value) => ({
        value, labelKey: `settings.voiceInput.speakerFilter.strictness.options.${value}`,
      })),
    ].map((option) => ({
      ...option,
      isVisible: ({ speakerFilter }: SettingsSearchContext) => speakerFilter?.supported === true && speakerFilter.enrolled,
    })),
    isVisible: ({ platform }) => platform === 'darwin' || platform === 'win32',
  },
  shortcutLabel: {
    id: 'settings.voiceInput.shortcut.label',
    fallbackTargetId: 'settings-panel-voice-input',
    tab: 'voice-input',
    targetId: 'settings-search-settings-voiceInput-shortcut-label',
    titleKey: 'settings.voiceInput.shortcut.label',
    sectionKey: 'settings.tabs.voiceInput',
    descriptionKey: 'settings.voiceInput.shortcut.hint',
    descriptionKeyForContext: ({ platform }) => platform === 'linux'
      ? 'settings.voiceInput.shortcut.linuxUnsupported' : undefined,
  },
  serviceSource: {
    id: 'voiceInput.serviceSource',
    tab: 'voice-input',
    targetId: 'settings-voice-serviceSource',
    fallbackTargetId: 'settings-panel-voice-input',
    titleKey: 'settings.voiceInput.serviceSource.label',
    descriptionKey: 'settings.voiceInput.serviceSource.hint',
    descriptionKeyForContext: ({ mode }) => mode === 'local'
      ? 'settings.voiceInput.serviceSource.localHint' : undefined,
    sectionKey: 'settings.tabs.voiceInput',
    options: [
      {
        value: 'cindy',
        labelKey: 'settings.voiceInput.serviceSource.options.cindy',
        descriptionKey: 'settings.voiceInput.serviceSource.optionDescriptions.cindy',
        isVisible: ({ mode }) => mode !== 'local',
      },
      {
        value: 'byok',
        labelKey: 'settings.voiceInput.serviceSource.options.byok',
        descriptionKey: 'settings.voiceInput.serviceSource.optionDescriptions.byok',
      },
    ],
  },
  asr: {
    isVisible: isByokVisible,
    id: 'voiceInput.asr',
    tab: 'voice-input',
    targetId: 'settings-voice-asr',
    fallbackTargetId: 'settings-panel-voice-input',
    titleKey: 'settings.voiceInput.serviceSource.asr.label',
    descriptionKey: 'settings.voiceInput.serviceSource.asr.hint',
    sectionKey: 'settings.tabs.voiceInput',
  },
  customAsrProtocol: {
    isVisible: isCustomAsrVisible,
    id: 'voiceInput.customAsrProtocol',
    tab: 'voice-input',
    targetId: 'settings-voice-customAsrProtocol',
    fallbackTargetId: 'settings-panel-voice-input',
    titleKey: 'settings.voiceInput.serviceSource.customAsr.protocol.label',
    descriptionKey: 'settings.voiceInput.serviceSource.customAsr.protocol.hint',
    sectionKey: 'settings.tabs.voiceInput',
    options: [
      {
        value: 'openai-realtime',
        labelKey: 'settings.voiceInput.serviceSource.customAsr.protocol.openai',
      },
      {
        value: 'qwen-realtime',
        labelKey: 'settings.voiceInput.serviceSource.customAsr.protocol.qwen',
      },
    ],
  },
  customAsrWebsocketUrl: {
    isVisible: isCustomAsrVisible,
    id: 'voiceInput.customAsrWebsocketUrl',
    tab: 'voice-input',
    targetId: 'settings-voice-customAsrWebsocketUrl',
    fallbackTargetId: 'settings-panel-voice-input',
    titleKey: 'settings.voiceInput.serviceSource.customAsr.websocketUrl.label',
    descriptionKey: 'settings.voiceInput.serviceSource.customAsr.websocketUrl.hint',
    sectionKey: 'settings.tabs.voiceInput',
  },
  customAsrModel: {
    isVisible: isCustomAsrVisible,
    id: 'voiceInput.customAsrModel',
    tab: 'voice-input',
    targetId: 'settings-voice-customAsrModel',
    fallbackTargetId: 'settings-panel-voice-input',
    titleKey: 'settings.voiceInput.serviceSource.customAsr.model.label',
    descriptionKey: 'settings.voiceInput.serviceSource.customAsr.model.hint',
    sectionKey: 'settings.tabs.voiceInput',
  },
  customAsrApiKey: {
    isVisible: isCustomAsrVisible,
    id: 'voiceInput.customAsrApiKey',
    tab: 'voice-input',
    targetId: 'settings-voice-customAsrApiKey',
    fallbackTargetId: 'settings-panel-voice-input',
    titleKey: 'settings.voiceInput.serviceSource.customAsr.apiKey.label',
    descriptionKey: 'settings.voiceInput.serviceSource.customAsr.apiKey.hint',
    sectionKey: 'settings.tabs.voiceInput',
  },
});

export default {
  id: 'voice-input',
  order: 6,
  entries: Object.values(voiceInputSettings),
} satisfies SettingsSearchModule;
