import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inspectSettingsControls,
  indexedSettingsTextKeys,
  registeredDefinitionExports,
} from "../check-settings-search.mjs";

// Guard runner behavior: an unregistered new switch previously passed every catalog
// check. In-memory TSX inputs exercise the real checker, including trusted-base
// allowances; no filesystem/Git fixtures or source-string assertions (unit tier).
// configuration-and-overrides.md §6; standalone local node:test run: 0.19s.
const registered = new Set(["./Page.settings-search#settings"]);
const imports = `import { useSettingDefinition } from './useSettingDefinition';
import { settings } from './Page.settings-search';`;
const bound = `${imports}
function Page() { const item = useSettingDefinition(settings.enabled);
return <Switch {...item.controlProps} checked={true} />; }`;

describe("settings search coverage gate", () => {
  it("rejects custom controls that discard or replace a registered caller ID", () => {
    for (const name of ['SegmentedControl', 'FontFamilyPicker', 'BotModelChainEditor', 'PillSelect', 'Select', 'BehaviorRow', 'OneshotModelPinPicker']) {
      const page = `${imports}\nconst page = <${name} data-setting-id={settings.enabled.id} />;`;
      const discarded = `function ${name}({ value }) { return <div />; }`;
      const replaced = `function ${name}({ 'data-setting-id': settingId }) { return <button data-setting-id={settings.other.id} />; }`;
      const forwarded = `function ${name}({ 'data-setting-id': settingId }) { return <button data-setting-id={settingId} />; }`;
      assert.ok(inspectSettingsControls(page + discarded, '', registered).length > 0, name);
      assert.ok(inspectSettingsControls(page + replaced, '', registered).length > 0, name);
      assert.deepEqual(inspectSettingsControls(page + forwarded, '', registered), []);
    }
  });
  // PR #8481: role-based selectors escaped the migrated-file contract. Exercise
  // the real checker with the smallest unbound role control (unit tier).
  // PR #8481: a two-hop adapter must not hide a dropped ID in its leaf control.
  it("checks the complete picker forwarding chain", () => {
    const page = imports + '\nimport { OneshotModelPinPicker } from "./Picker"; const page = <OneshotModelPinPicker data-setting-id={settings.enabled.id} />;';
    const adapter = 'import { ModelSelector } from "./Selector"; export function OneshotModelPinPicker({ "data-setting-id": id }) { return <ModelSelector data-setting-id={id} />; }';
    const leaf = 'export function ModelSelector({ "data-setting-id": id }) { return <button data-setting-id={id} />; }';
    const sources = new Map([['./Picker#OneshotModelPinPicker', adapter], ['./Selector#ModelSelector', leaf]]);
    assert.deepEqual(inspectSettingsControls(page, '', registered, new Set(), sources), []);
    sources.set('./Selector#ModelSelector', leaf.replace('data-setting-id={id}', ''));
    assert.equal(inspectSettingsControls(page, '', registered, new Set(), sources).length, 1);
    sources.delete('./Selector#ModelSelector');
    assert.equal(inspectSettingsControls(page, '', registered, new Set(), sources).length, 1);
    sources.set('./Selector#ModelSelector', leaf);
    sources.set('./Picker#OneshotModelPinPicker', adapter.replace('data-setting-id={id}', ''));
    assert.equal(inspectSettingsControls(page, '', registered, new Set(), sources).length, 1);
  });
  it("checks intrinsic interactive roles without treating status text as a control", () => {
    for (const role of ['button', 'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'slider', 'spinbutton', 'option']) {
      for (const roleAttribute of [`role="${role}"`, `role={'${role}'}`]) {
        const unbound = `${imports}\nconst page = <div ${roleAttribute} />;`;
        assert.equal(inspectSettingsControls(unbound, unbound, registered).length, 1, roleAttribute);
        assert.deepEqual(inspectSettingsControls(unbound.replace(' />', ' data-setting-id={settings.enabled.id} />'), '', registered), []);
      }
    }
    assert.deepEqual(inspectSettingsControls(`${imports}\nconst page = <div role="status" />;`, '', registered), []);
    assert.deepEqual(inspectSettingsControls('<div role="button" data-settings-search-action="Preview the next animation" />'), []);
  });
  it("requires each reusable behavior row caller to supply its registered ID", () => {
    const wrapper = `function BehaviorRow({ 'data-setting-id': settingId }) { return <Switch data-setting-id={settingId} />; }`;
    const source = `${imports}\n${wrapper}\nconst page = <BehaviorRow data-setting-id={settings.enabled.id} />;`;
    assert.deepEqual(inspectSettingsControls(source, '', registered), []);
    assert.equal(inspectSettingsControls(source.replace('data-setting-id={settings.enabled.id}', ''), '', registered).length, 1);
  });
  it("checks imported custom-control implementations even through aliases", () => {
    const page = `${imports}\nimport { SegmentedControl as Choice } from './Choice';
      const item = useSettingDefinition(settings.enabled); const page = <Choice {...item.controlProps} />;`;
    const forwarding = `export function SegmentedControl({ 'data-setting-id': settingId }) { return <div data-setting-id={settingId} />; }`;
    assert.equal(inspectSettingsControls(page, '', registered).length, 1);
    assert.deepEqual(inspectSettingsControls(page, '', registered, new Set(), new Map([['./Choice#SegmentedControl', forwarding]])), []);
    assert.equal(inspectSettingsControls(page, '', registered, new Set(), new Map([['./Choice#SegmentedControl', forwarding.replace('{settingId}', '"wrong"')]])).length, 1);
  });
  it("catches a new label even when the legacy control opening is unchanged", () => {
    const old = "const page = <Switch checked={true} />;";
    const source = old + "const label = t('settings.newFeature.label');";
    assert.equal(inspectSettingsControls(source, old).length, 1);
    assert.deepEqual(
      inspectSettingsControls(
        source,
        old,
        new Set(),
        new Set(["settings.newFeature.label"]),
      ),
      [],
    );
  });
  it("blocks new controls and permits only unchanged legacy occurrences", () => {
    const old = "const page = <Switch checked={true} />;";
    assert.equal(inspectSettingsControls(old).length, 1);
    assert.deepEqual(inspectSettingsControls(old, old), []);
    assert.equal(inspectSettingsControls(old + old, old).length, 1);
    assert.equal(
      inspectSettingsControls(old.replace("true", "false"), old).length,
      1,
    );
  });
  it("requires a definition that is registered, not just an arbitrary spread", () => {
    assert.deepEqual(inspectSettingsControls(bound, "", registered), []);
    assert.equal(inspectSettingsControls(bound).length, 1);
    assert.equal(
      inspectSettingsControls(
        bound.replace("item.controlProps", "unbound.controlProps"),
        "",
        registered,
      ).length,
      1,
    );
  });
  it("checks direct bindings and reusable rows with conditional registered definitions", () => {
    // Large pages retain their existing t() interpolation; their controls still need
    // a catalog-backed definition. A same-named unregistered import must not pass.
    const direct = `${imports}\nconst row = <Select.Trigger data-setting-id={settings.enabled.id} />;`;
    assert.deepEqual(inspectSettingsControls(direct, "", registered), []);
    assert.equal(inspectSettingsControls(direct).length, 1);
    const conditional = `${imports}\nfunction Row({ local }) {
      const definition = local ? settings.local : settings.web;
      const item = useSettingDefinition(definition);
      return <SegmentedControl {...item.controlProps} />;
    }`;
    const implementation = `function SegmentedControl({ 'data-setting-id': settingId }) { return <div data-setting-id={settingId} />; }`;
    assert.deepEqual(inspectSettingsControls(conditional + implementation, "", registered), []);
    assert.equal(
      inspectSettingsControls(
        conditional.replace("settings.local", "unregistered.local") + implementation,
        "",
        registered,
      ).length,
      1,
    );
    const extra = direct + "\nconst unbound = <VoiceInputSelect />;";
    assert.equal(inspectSettingsControls(extra, extra, registered).length, 1);
  });
  // Guard regression (#8481): generated shortcut maps must remain tied to a
  // registered catalog; computed access is not permission to use an arbitrary ID.
  it("validates indexed definitions only from registered collections", () => {
    const source = `${imports}\nconst setting = settings[row.id]; const control = <button data-setting-id={setting.id} />;`;
    assert.deepEqual(inspectSettingsControls(source, "", registered), []);
    assert.equal(inspectSettingsControls(source, "", new Set()).length, 1);
    assert.equal(inspectSettingsControls(source.replace('settings[row.id]', 'unrelated[row.id]'), "", registered).length, 1);
    assert.equal(inspectSettingsControls(source.replace('setting.id}', 'row.id}'), "", registered).length, 1);
  });
  it("keeps migrated files strict even when a new control existed at the Git base", () => {
    const source = bound + "\nconst extra = <Input />;";
    assert.equal(inspectSettingsControls(source, source, registered).length, 1);
    assert.equal(
      inspectSettingsControls("const extra = <Input />;", source, registered)
        .length,
      1,
    );
  });
  it("accepts forwarded IDs only inside checked controls and still checks their callers", () => {
    const wrapper = `function VoiceInputSelect({ value, 'data-setting-id': settingId }) {
      return <button data-setting-id={settingId} />;
    }`;
    const source = `${imports}\n${wrapper}\nconst page = <VoiceInputSelect data-setting-id={settings.enabled.id} />;`;
    assert.deepEqual(inspectSettingsControls(source, "", registered), []);
    assert.equal(inspectSettingsControls(source.replace('data-setting-id={settings.enabled.id}', ''), "", registered).length, 1);
    assert.equal(inspectSettingsControls(wrapper.replace('VoiceInputSelect', 'UntrackedControl')).length, 1);
    assert.equal(inspectSettingsControls(wrapper.replace('data-setting-id={settingId}', 'data-setting-id={unrelated}')).length, 1);
  });
  it("recognizes aliased controls and native form controls", () => {
    assert.equal(
      inspectSettingsControls(
        "import { Switch as Toggle } from '@/components/ui/switch'; const x = <Toggle />;",
      ).length,
      1,
    );
    assert.equal(
      inspectSettingsControls("const x = <><input /><select /><textarea /></>;")
        .length,
      3,
    );
  });
  it("allows an explicit ordinary-action reason, but not a blank exemption", () => {
    assert.deepEqual(
      inspectSettingsControls(
        '<Button data-settings-search-action="Cancel editing this connection" />',
      ),
      [],
    );
    assert.equal(
      inspectSettingsControls('<Button data-settings-search-action="" />')
        .length,
      1,
    );
  });
  it("requires named definitions to feed the discovered default module", () => {
    const declaration =
      "export const settings = defineSettings({ enabled: {} });";
    assert.deepEqual([...registeredDefinitionExports(declaration)], []);
    assert.deepEqual(
      [
        ...registeredDefinitionExports(
          declaration + "export default { entries: Object.values(settings) };",
        ),
      ],
      ["settings"],
    );
    assert.deepEqual(
      [
        ...registeredDefinitionExports(
          declaration +
            "export default { unrelated: Object.values(settings), entries: [] };",
        ),
      ],
      [],
    );
  });
  it("does not count unused definitions as searchable text", () => {
    const definitions =
      "export const settings = defineSettings({ enabled: { titleKey: 'settings.new.label' } });";
    assert.deepEqual([...indexedSettingsTextKeys(definitions)], []);
    assert.deepEqual(
      [
        ...indexedSettingsTextKeys(
          definitions + "export default { entries: Object.values(settings) };",
        ),
      ],
      ["settings.new.label"],
    );
  });
});
