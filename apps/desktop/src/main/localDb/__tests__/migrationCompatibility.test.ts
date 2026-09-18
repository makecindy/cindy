import Database from 'better-sqlite3';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkMigrationCompatibility,
  createMigrationRuntimeManifest,
  hashMigrationFile,
  migrationRuntimeManifestPath,
  prepareMigrationRuntimeManifest,
} from '../migrationRunner';

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDrizzleDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cindy-passive-migrations-'));
  cleanupDirs.push(dir);
  writeFileSync(path.join(dir, '0000_init.sql'), 'CREATE TABLE first (id TEXT);\n', 'utf8');
  writeFileSync(path.join(dir, '0001_second.sql'), 'CREATE TABLE second (id TEXT);\n', 'utf8');
  return dir;
}

function createDb(schemaVersion: number, withHistory = true): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE migration_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    INSERT INTO migration_meta (key, value) VALUES ('schema_version', '${schemaVersion}');
  `);
  if (withHistory) {
    db.exec(`
      CREATE TABLE migration_history (
        seq INTEGER PRIMARY KEY NOT NULL,
        file_name TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
  }
  return db;
}

/**
 * 复制真实 drizzle 文件，让 runtime identity 与生产登记的重编号指纹一致；
 * 用 stub 文件驱动这些登记会变成「未登记身份漂移」，测不出重编号路径。
 */
function copyMigrationFiles(targetDir: string, fileNames: readonly string[]): void {
  const sourceDir = path.resolve(__dirname, '../../../../drizzle');
  for (const fileName of fileNames) {
    copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName));
    const companionName = fileName.replace(/\.sql$/, '.ts');
    const companionSource = path.join(sourceDir, 'scripts', companionName);
    if (existsSync(companionSource)) {
      mkdirSync(path.join(targetDir, 'scripts'), { recursive: true });
      copyFileSync(companionSource, path.join(targetDir, 'scripts', companionName));
    }
  }
}

function writeDrizzleFile(targetDir: string, fileName: string, content: string): void {
  writeFileSync(path.join(targetDir, fileName), content, 'utf8');
}

const RENUMBERED_APPLIED_SEQ = 108;
const RENUMBERED_SQL_HASH = 'dd2c6cd26bdd7420d17046c67a0043cae099ded9b3bf01d68c453c46bf8cc40b';
const RENUMBERED_APPLIED_FILE = '0108_loose_puppet_master.sql';
const RENUMBERED_CANONICAL_FILE = '0110_green_unus.sql';
/** 663654be2 上的冻结内容（开发分支 0108_loose_puppet_master.sql，无尾换行）。 */
const RENUMBERED_APPLIED_SQL = 'ALTER TABLE `sessions` ADD `context_window_budget` integer;';
/**
 * 真实落库现场（2026-09-17 开发分支的 runtime manifest）：0..108 已 applied，
 * 其中 108 是被重编号的 0108_loose_puppet_master（context_window_budget），
 * canonical 链把它换成 0110_green_unus。低序号条目直接沿用真实指纹，
 * 避免用 stub 文件制造假的「未登记漂移」。
 */
const RENUMBERED_MANIFEST: {
  version: 1;
  legacyBaselineVersion: number;
  migrations: Array<{ seq: number; fileName: string; sqlHash: string; scriptHash: string | null }>;
} = {"version":1,"legacyBaselineVersion":105,"migrations":[{"seq":0,"fileName":"0000_init.sql","sqlHash":"1e9cde03038e90171698488b57b25ef3097964c595e8889f7316f0363482584b","scriptHash":null},{"seq":1,"fileName":"0001_add_agent_meta.sql","sqlHash":"9419a15f94d3806cee4fbb04d811fd6dcbd4329e2d475db7ccf5e7545ae6e030","scriptHash":null},{"seq":2,"fileName":"0002_add_user_send_at.sql","sqlHash":"f3ace06a49af4448a7b22667803d510656b4b26c39f1cc72f61956f9a204ed55","scriptHash":null},{"seq":3,"fileName":"0003_add_session_fork.sql","sqlHash":"f551156a67002a5e0a6a99866cb4edde676b0b21f6b17f59cffdf72d3d273edb","scriptHash":null},{"seq":4,"fileName":"0004_add_message_rewind_at.sql","sqlHash":"e1b38aaac6d732ec302271046e96d345ffbff136984e181015d25c70ecbbb967","scriptHash":null},{"seq":5,"fileName":"0005_add_session_worktree_path.sql","sqlHash":"14cc1228b0bbd2bdc921e4e686ca529127e2de4ae3f9577c672a6f2a4b15d617","scriptHash":null},{"seq":6,"fileName":"0006_add_daily_spend.sql","sqlHash":"14e8c96bc43a4ae6b149f89a1b61cbef9a5340244a4065fedf4e4cb5f0b4b870","scriptHash":null},{"seq":7,"fileName":"0007_great_anita_blake.sql","sqlHash":"a567bb4a7a0bbf79e003a4ab68502d24a1a25e9e512c9737e640f639a4331baf","scriptHash":null},{"seq":8,"fileName":"0008_lyrical_tinkerer.sql","sqlHash":"ff8d4f0537d30489f3dae2d496c0da0997a12c3bcb500c45c6f6a790634dcdf5","scriptHash":null},{"seq":9,"fileName":"0009_swift_stick.sql","sqlHash":"fcf35490aaf5a3beb521caca840a02d2de79a387263a67b41fde96ff3c4ffb1e","scriptHash":null},{"seq":10,"fileName":"0010_complex_madame_hydra.sql","sqlHash":"167dc549c5f81a55d14da1fa7badc3c4fcd99646d6e950af836e0362e7ed6e87","scriptHash":null},{"seq":11,"fileName":"0011_eminent_dragon_lord.sql","sqlHash":"7d20b008b4adf82aacdb33088ab1dba47d7d9b5d3714d767b77fc8e8a7a85e87","scriptHash":null},{"seq":12,"fileName":"0012_yummy_archangel.sql","sqlHash":"a2a80fe0aa57855e7576145f963f1d46a3553b59b3dd9de6c121356e53fdcf72","scriptHash":null},{"seq":13,"fileName":"0013_daily_wallflower.sql","sqlHash":"8f05ae13831a0a26b79a29d09558f7d438f3efa2f757f777f4f19809e2715af3","scriptHash":null},{"seq":14,"fileName":"0014_calm_miracleman.sql","sqlHash":"446f25590b7fef59f29e8f53bc0770ede2fad8e85464ce759a79c95dc1352cb1","scriptHash":null},{"seq":15,"fileName":"0015_add_schedule_interval_ms.sql","sqlHash":"a3c2b89ba72de17f7c9453859526e2b4021588d6a7263418bbaa4c7bcb377300","scriptHash":null},{"seq":16,"fileName":"0016_magenta_corsair.sql","sqlHash":"9a04c8dc7d9d461111a22beb49312f25621a1f32b2c585241cd4d636fd7d1d61","scriptHash":null},{"seq":17,"fileName":"0017_add_messages_fts.sql","sqlHash":"bb5d8a556879fd24ee6a24521b66a6561223bad4c256bc7e0bcb09b22f4fabdf","scriptHash":null},{"seq":18,"fileName":"0018_session_used_project_context.sql","sqlHash":"c5ad1852d8263121add2e88a231697112acbbb2cd181f994314e3d375034215c","scriptHash":null},{"seq":19,"fileName":"0019_session_extra_dirs.sql","sqlHash":"cfcdc635024aae0683179c82afe4e085d3f32bf0be8b452553c17880fc96bbbb","scriptHash":null},{"seq":20,"fileName":"0020_drop_issue_triage_blacklist.sql","sqlHash":"e16e60cefb7bcf1277260f1558fd9486277155d51b771afb38e03f098935e7d0","scriptHash":null},{"seq":21,"fileName":"0021_add_schedule_persistent_session.sql","sqlHash":"82f0ed4827638405b95024051006cf7940a02cdf11f02cc229f9ba388bf29bdc","scriptHash":null},{"seq":22,"fileName":"0022_curvy_luckman.sql","sqlHash":"a932d234fdc7c96cdfb5a2f664ba0cc3d813cad56e9be4c3bd7108be3290589c","scriptHash":null},{"seq":23,"fileName":"0023_session_workspace_kind.sql","sqlHash":"3c4482a2d994b3cae4393cb7d9b28a70872903bc8511c3ebe32faae1dd2e8068","scriptHash":null},{"seq":24,"fileName":"0024_ensure_session_workspace_kind.sql","sqlHash":"9558e289b0007ef7931a471586b931c8d1cf5a6482aafbcc4b5eb575140ce171","scriptHash":"613c57cc71c694fc2ee44949715c1ca347c3269416c730d051642ed6bc216992"},{"seq":25,"fileName":"0025_reclassify_codex_projectless_dialogues.sql","sqlHash":"93eff6955cda1f8cfd0dfe4fe13c4479e72cf68149f5dbe8d478395df29cd583","scriptHash":"8a23fe1dbf174dfbbf3440679735bdcc6a02019efd26e8d2a71c5998ee319620"},{"seq":26,"fileName":"0026_migration_history.sql","sqlHash":"207dc9a0c78703a5c8907ea39f4a34d34cf5c683142ba5b053e3bdf154ecb9e9","scriptHash":"62b7636ec3fb35dadc38304b0ceb22fe44113a288c16840504ffbeae141642fd"},{"seq":27,"fileName":"0027_flawless_victor_mancha.sql","sqlHash":"ec63db3e2736e7e32b0be83aa9dd86b9b19e6b5d0c7a56cc722399f54e0ed39f","scriptHash":null},{"seq":28,"fileName":"0028_drop_schedule_job_type.sql","sqlHash":"5f5918b4b7170a65a5a7511dbe1e4be35c6f364f0c7e08bb95abc79500c445c7","scriptHash":null},{"seq":29,"fileName":"0029_restore_schedule_job_type_compat.sql","sqlHash":"c144e0999491eaa8fbdb2667b66e734bf42a945243088474946f846a7e063517","scriptHash":null},{"seq":30,"fileName":"0030_slow_namora.sql","sqlHash":"560941adf15f50de49a210e5113b70afea4590bad963795aeaa99c5b4c408489","scriptHash":null},{"seq":31,"fileName":"0031_add_recent_workdirs.sql","sqlHash":"896d9aae2f1c2988e2d2828cda71fbfab14773bf413d3e85d62e6121db4dc7f0","scriptHash":"98d216882bb494129214d23c2935f9702cab2523b5d62eb59678577d1717cffc"},{"seq":32,"fileName":"0032_light_stone_men.sql","sqlHash":"395f3909bf31c0a859fa97e511a009d77573b092eeb9e92dd1355d2331f181a3","scriptHash":null},{"seq":33,"fileName":"0033_omniscient_whistler.sql","sqlHash":"23a8e896576584f73180750d0760caee5b4a2ec372789e2ffe6446fbad04b505","scriptHash":null},{"seq":34,"fileName":"0034_add_chat_embedding_vec.sql","sqlHash":"c1ab1f6eef2989118cf38369858e85f50f061139d2f757c90c9432d4c5903378","scriptHash":null},{"seq":35,"fileName":"0035_clean_scheduler_recent_workdirs.sql","sqlHash":"9c13ac9c575ee93bb93a79ddde47c98e514e28ba9ced633f2e378265326b2718","scriptHash":"120354d9ed5e97bd88127ee416e2fd05a4db526cd120acf1193b186a9085399a"},{"seq":36,"fileName":"0036_drop_stale_orca_lead_index.sql","sqlHash":"b0cb20db6fe0862889048d5c40043cbffd9d7af02e0e1b5b80832fb1563239bc","scriptHash":null},{"seq":37,"fileName":"0037_thankful_captain_britain.sql","sqlHash":"81cdaabcb6a9a594f2142b1066c1a7a17ee0242b3cad8781b8087851ac3e3109","scriptHash":null},{"seq":38,"fileName":"0038_add_session_remote_host_id.sql","sqlHash":"614ac61ee36e598124cab5b437ea209fe454b5b94c83ff02670999abbd890f6e","scriptHash":"7581e0e83ad13496fe5e8bec90198ae502418b4f9ab3c30a3a8e0439724e04f9"},{"seq":39,"fileName":"0039_fearless_victor_mancha.sql","sqlHash":"4ce120b1ff9b9cbbfea6d00aa378ab075f403a5b261fe9f00f544a9865c0a59b","scriptHash":null},{"seq":40,"fileName":"0040_orca_multi_worker_phase1.sql","sqlHash":"544bf1494ed41fda95cc683d7abfa174c29c080a3fcb544418df2527e07d5522","scriptHash":"7ea9d259d40361c60d86281e18a4418a33ad81153067bdaa9233bc35b61a799d"},{"seq":41,"fileName":"0041_robust_sue_storm.sql","sqlHash":"45942e508f8a70b945858ced30aa9bd06e19842c731a821f53583f4c02498709","scriptHash":null},{"seq":42,"fileName":"0042_chemical_daredevil.sql","sqlHash":"4c26a7aadf051c69671fd4dd43ba6e73cb62e1dba05d7a39fa63a86b743d7069","scriptHash":null},{"seq":43,"fileName":"0043_aromatic_speed.sql","sqlHash":"594a4d8df0e3373ea4f8fef742e0c2b109e2d3ad0917c0f2fdf1f168ed8de820","scriptHash":null},{"seq":44,"fileName":"0044_early_talos.sql","sqlHash":"17440af6e1144e0449d169c6f91eb1a23134461a1c1f26261bb52d5f4c2a586f","scriptHash":null},{"seq":45,"fileName":"0045_living_namor.sql","sqlHash":"94a9726abcb7b4dbac9fb5e50f301943e3b6a54cc9bc1ffe83bef46550e37e4e","scriptHash":null},{"seq":46,"fileName":"0046_dapper_dracula.sql","sqlHash":"d96aa2c5ab2c8e675a63a931ae59a30fcf7161eba8b7a0e80a5ded763f68647b","scriptHash":null},{"seq":47,"fileName":"0047_lame_malice.sql","sqlHash":"06bfc3ee9e88b6c12fe951e027fb45d647d2a6d20b9745e611f8abf0e6e1d3de","scriptHash":null},{"seq":48,"fileName":"0048_add_session_summary.sql","sqlHash":"6fe0d6c7f09c015b4d53b61ded409dc03ea16ce4e9ffcd49957c34efafe09475","scriptHash":"bdad93339aa3f11360ffb9a8b62fae9965075fe3d5d866e67fa1eb0c74b064c1"},{"seq":49,"fileName":"0049_oval_lockheed.sql","sqlHash":"bc6d3e472cb00f97c5e06131e23ec43ccd77565d70a0255a5a4fc4d686fa68b9","scriptHash":null},{"seq":50,"fileName":"0050_fantastic_korvac.sql","sqlHash":"7105a7a2b2460285c4573164980d2949dd48e79ec491c079ecbd167d306543d0","scriptHash":null},{"seq":51,"fileName":"0051_late_echo.sql","sqlHash":"08bfb0b2bd669436f5798715beb2d0e585f45d0ad48e085f2e36c0e08d99ffd8","scriptHash":null},{"seq":52,"fileName":"0052_breezy_tag.sql","sqlHash":"7ccc61e7ddbd8d44ec0ae290d8728d2bd43cf79d360a5ad541d968f2e37616c0","scriptHash":null},{"seq":53,"fileName":"0053_jazzy_wraith.sql","sqlHash":"1d3115c1dc80aaf61cfb5ec153291115c11e62bde5bb266685653e58431933da","scriptHash":null},{"seq":54,"fileName":"0054_fair_mentor.sql","sqlHash":"6b7c0fa4c22f651635f8dd2a5193263e1ee16fbd5d355257855c8afe0252f49a","scriptHash":null},{"seq":55,"fileName":"0055_quick_tony_stark.sql","sqlHash":"d935d2132ef00d923a79c4ebb4719157337fa63e62307b7592b620ba2fede6ee","scriptHash":null},{"seq":56,"fileName":"0056_chunky_squirrel_girl.sql","sqlHash":"ae47ae2c5e1fd1363639f20e530213142a4ed33ac6bf7b320230b456e6370d06","scriptHash":null},{"seq":57,"fileName":"0057_quiet_namora.sql","sqlHash":"e2fa3db6c78242bac013ae2e53b614b81c3f0789e2aa2f6b42a931fbbc722486","scriptHash":null},{"seq":58,"fileName":"0058_daily_cobalt_man.sql","sqlHash":"32c674d0abc44804b890823e78abdeaf31c137b4d50778d62b2e2989eb40a807","scriptHash":null},{"seq":59,"fileName":"0059_ancient_hex.sql","sqlHash":"d2fb9eb3b6e28e29f99dba139e1a07cb7a7792aeba3701f800aeabfbe3de7709","scriptHash":null},{"seq":60,"fileName":"0060_orange_penance.sql","sqlHash":"c102a337791107a5e5e747851b259b7fe77e6e3452e878977c174da7e51b9240","scriptHash":"1d31303c10b5cdac5b66aec9345377f8e3a8dec52367ec19eccf3804ec44c7a4"},{"seq":61,"fileName":"0061_bizarre_firestar.sql","sqlHash":"43574aefb477039821bc4b792e79bcec6b79bdc3223a15df64110ca319d0b134","scriptHash":"1a0e89015d051f7b2ae24ba4471dd1e3a1d2fe203d47e24247b05ced9e535677"},{"seq":62,"fileName":"0062_flaky_mimic.sql","sqlHash":"77b8741ac31c159eb422746c0165d102ad65693236c80d0ff055fd70cd43fe68","scriptHash":"0a72ba2d89237b4b7322ffbbeb644c94e01be7d159851e220f51c03edfa80b78"},{"seq":63,"fileName":"0063_handy_tenebrous.sql","sqlHash":"25951e494866345cbbd0cf9031b486d086598f94ed95bbca137905381aed814a","scriptHash":null},{"seq":64,"fileName":"0064_icy_bruce_banner.sql","sqlHash":"94b35ed3f35d5908bd6810007e3017c761b5e68ac6b3b43e80b22aed0b89feae","scriptHash":"ca64c489a6c8fa0789cd93a5f0acbd4aa0297d67eaa6121e45026026e771bd7f"},{"seq":65,"fileName":"0065_equal_shinobi_shaw.sql","sqlHash":"2a65e5b3d6beceb537473ac9aebe686389bbb1eb78d299402b68d0f5b5dfe780","scriptHash":"ea57a4a027be2167eed457a5f13dc7e95b9ed2122caf096e7070c2a23481c537"},{"seq":66,"fileName":"0066_slim_messages_fts.sql","sqlHash":"bcf44a83da1bf244babb8b52acb7c3da7deda68cdc580df13050ced8cc09ce2c","scriptHash":"42f638fc5a119d80fd068b36232b5b3b47782658da23e5e725a1b569fae0477c"},{"seq":67,"fileName":"0067_freezing_molecule_man.sql","sqlHash":"71a1a1f0c17cb33012d1f6f30c471708772bbe77418aa9bf2ef096e74953a06e","scriptHash":null},{"seq":68,"fileName":"0068_gifted_ser_duncan.sql","sqlHash":"7fec7d4bdc196755b8dab5c2e182ab4bc301d6e42e906cf4c3b4bc9076ed3272","scriptHash":null},{"seq":69,"fileName":"0069_unusual_loki.sql","sqlHash":"9e27a92c5ef5f66642e4ed7179736157f196e8a5154386085e5a44b7be90f402","scriptHash":"e7e807430b4e7e401fba1192b9c2ea7589bc9841c4398496d3bf48f9f31e1ade"},{"seq":70,"fileName":"0070_woozy_harpoon.sql","sqlHash":"6ca932b0c31ecc10e242cb5d6310886f736d2c61ad16a8778dbc328fa98a820f","scriptHash":null},{"seq":71,"fileName":"0071_bright_ultron.sql","sqlHash":"80d87a1da8a6626eb66371a1580fd3ec72a8e28274a2713a7c070cf34bb7e057","scriptHash":"79e8fa4c645a6760c66bab32e0847b85ec4a4018a00754a40339096d278ce73f"},{"seq":72,"fileName":"0072_first_lightspeed.sql","sqlHash":"9f44429d7e8f49f2c114a1a103469e427be03e7fa2e6c7801472700fec6a5f9a","scriptHash":null},{"seq":73,"fileName":"0073_thankful_hex.sql","sqlHash":"45204245bf226cd740b99b013f73df0ca52e9254764f86dde5f182cc4151ad8a","scriptHash":"2e16a36256e00ad4be883438d11ecdd12306607e9ccf8f137c2887eb1452047e"},{"seq":74,"fileName":"0074_bridge_legacy_migration_lineage.sql","sqlHash":"51742f4eb58ad542be550d2a698a0e61cfca1a9fbb0074be98e7f31a6749c75e","scriptHash":"947866cc745680b19b19fe277952473b850da1e1dc684c5a90246b15e80ac00b"},{"seq":75,"fileName":"0075_complex_strong_guy.sql","sqlHash":"1880cc34e5af4a684828a9eeb95737f03bd3f3f4c98265af8be0b694d8dd204d","scriptHash":"7a093a684b90a54088beeafae666cbd115371efa98afdc788e7b9391443e2eaf"},{"seq":76,"fileName":"0076_melted_post.sql","sqlHash":"912e6d75166ee0bfaf51942d34ab527042d1803971db7929cf90429a8c2cebe8","scriptHash":"bf6aca5b143f9f7902146ee3032ff366a73887d54679ca7736b74395102dc4cc"},{"seq":77,"fileName":"0077_nebulous_veda.sql","sqlHash":"6d54ca60ebe0a0d2d23a88cc266b726bddf10f3a9b80dce07a3fa71d13418804","scriptHash":"e60548298f1a1448c398bc5e2dd669acf3fb5e5675f08f908a196d72e44403d9"},{"seq":78,"fileName":"0078_same_juggernaut.sql","sqlHash":"ac078c551e24c0f422898f14e12ecc4ea29d09ab43f43e8b1272c79eee65f24b","scriptHash":"fbb6171d45755277e2c242afd0da3b7ed96cca002fadc68043cb06f8bc95b8e2"},{"seq":79,"fileName":"0079_futuristic_hercules.sql","sqlHash":"9a631fc8e6985c750971777332fdccfcfd7f47fa2e88dc9746d1bc64415db97f","scriptHash":"e22a98267ba885e1d772e0f584f0f9a837709eb9d6bdf3d4c4d8e50c4cf51b8a"},{"seq":80,"fileName":"0080_regional_money.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"1706b12e69f7b00e8bbe22839fafa4d60c10732957c42e6dc4f8da8d53d58f75"},{"seq":81,"fileName":"0081_preserve_gateway_currency.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"59fea9c6af9f4b5ab48245af7f26053e420eb9fbf8f8ac54aac69a0f74826a35"},{"seq":82,"fileName":"0082_daffy_calypso.sql","sqlHash":"f7fabe368b82f16c88de15004b03beb3febe35726ad5a966c234e187dd7beaf5","scriptHash":null},{"seq":83,"fileName":"0083_gray_katie_power.sql","sqlHash":"e58e1b24c036adfcf66fa2e086e08e04ef469ae4968bc741e2d9f2b47e30c0bc","scriptHash":null},{"seq":84,"fileName":"0084_small_gwen_stacy.sql","sqlHash":"8d1d280cacfe917e2b2e46223506722d0e2502a9aecaab63e36c3d7e32e5410f","scriptHash":null},{"seq":85,"fileName":"0085_skinny_iron_man.sql","sqlHash":"27b4c7095e397a6187bae9a53c26017bf750c14a4e080ff4691b7161073fc4ac","scriptHash":"1e74cb6e302731ab0d414ce9e166998434db5a3645db4bf50c0cc5363313b1ab"},{"seq":86,"fileName":"0086_orange_surge.sql","sqlHash":"39414b94d99711391494f6f33d3c7391486033852ff9ff3c9009718be01dddf7","scriptHash":null},{"seq":87,"fileName":"0087_puzzling_shen.sql","sqlHash":"5e1949cc23440b1a0ee7f8fe104cb7411e1671c1e451c3d3b4093daa0354a855","scriptHash":null},{"seq":88,"fileName":"0088_thankful_captain_midlands.sql","sqlHash":"bfa75ed882e46bea269df9049fabb36c5659ac405bb0a066d50575e7cc0581ce","scriptHash":null},{"seq":89,"fileName":"0089_rich_power_pack.sql","sqlHash":"d0a45a87a603457d200e19fda6b474dea482cf728226824c67303bf0dc0756c3","scriptHash":"259b6089b2d2d902d1d2f699fcfe64654c169793eed54aedafd246ecd75a3026"},{"seq":90,"fileName":"0090_distinguish_xai_provider_provenance.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"98d6a8b979f46bea790cdfa9605be468f0e863b01a1513312d6d556fff880e0f"},{"seq":91,"fileName":"0091_amazing_blur.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"392ad0661febf5775498c83d5c94766e38ccb1b34cf356b1e222b6247a8656b8"},{"seq":92,"fileName":"0092_fixed_zeigeist.sql","sqlHash":"841eb6a3b43bcb17910ca487825b1fd2fab4d9f111fac79f90be436067f0911f","scriptHash":"e9192d48ec87fa11db67a8147ff7c948fd789a0d9819982aec64d2c04ca96388"},{"seq":93,"fileName":"0093_parched_switch.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"08c109aae407b82af38cceb023a833b2b6b7a67babb23c526b634c94b912600e"},{"seq":94,"fileName":"0094_repair_custom_provider_timestamps.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"a2075d1a95d295d476ef015937230cb21d6663f6b71a3b989f6ee4bc6a9f15c9"},{"seq":95,"fileName":"0095_scope_messages_fts_update_trigger.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"feda1dd5b0870339395201e85ad8d9b5c22da484d07f1bbf5f9073f9d7ca53be"},{"seq":96,"fileName":"0096_stabilize_messages_fts_rows.sql","sqlHash":"1a4eb081db536e1542aeff521c78c25b8f262fa63e61fc545ac6644e8abcb201","scriptHash":"ecc20ddd4e168a7db66e7fb74fd7c1912bab9462e6db276de010b38b9c999ce4"},{"seq":97,"fileName":"0097_fresh_stryfe.sql","sqlHash":"17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a","scriptHash":"ceb0e267883bbbf0a8d23b86bf272ec7f704ca6a1d9424d9e5d593df8cf7d182"},{"seq":98,"fileName":"0098_bright_baron_zemo.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"0f81cc0b8f238878d4be4c67641a215bc0e4b9512d410a0a22ff42099db54a06"},{"seq":99,"fileName":"0099_boring_champions.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"353f473ef643cadd07f6fede066f27dd5d1f01ef73941bb4c678824e62d76fea"},{"seq":100,"fileName":"0100_segment_messages_fts_cjk.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"4a3318b13c29dab996e4c785e0e424cf63a905e35a471738b50f25e28def8120"},{"seq":101,"fileName":"0101_repair_cjk_fts_missing_rows.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"fa7a77fe27809aba9e1bfb9cebe546fa26c1f14b0e41a305fda6ce3c14b28988"},{"seq":102,"fileName":"0102_optimal_ender_wiggin.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"e5206a470f2bfbbb937c18d776e372986207be5cc0ca481f7faab473815f69f9"},{"seq":103,"fileName":"0103_bot_mode.sql","sqlHash":"17f781990964f826f734710d40eebe8b3830571993c394db935f540062735985","scriptHash":null},{"seq":104,"fileName":"0104_schedule-model-harness.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"8bfd127690395aac0298708694a9ea2546c0b64f005ea8ac5fef5e8996527ec1"},{"seq":105,"fileName":"0105_context_window_runtime.sql","sqlHash":"3656ad42874754d8b50acb48d330aa4ddb50b561f3ece3acd240f5d6f40d4c40","scriptHash":null},{"seq":106,"fileName":"0106_retain_all_recent_workdirs.sql","sqlHash":"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd","scriptHash":"874ba3c4867c9e4ce7448341f0513ae2aaa1b9c951f7d8869a226a5b9f6db677"},{"seq":107,"fileName":"0107_sudden_ultron.sql","sqlHash":"e8f1b27ab6a28c4766c59a660ca6a8a12689aa1d60742d9a309fea366261afe5","scriptHash":null},{"seq":108,"fileName":"0108_loose_puppet_master.sql","sqlHash":"dd2c6cd26bdd7420d17046c67a0043cae099ded9b3bf01d68c453c46bf8cc40b","scriptHash":null}]};

/** 落库前缀 manifest（由 canonical 条目直接构造，只把 108 换成重编号前的旧身份）。 */
function seedRenumberedManifest(dbFilePath: string, drizzleDir: string): void {
  const appliedPrefix = createMigrationRuntimeManifest(drizzleDir)
    .migrations.filter((identity) => identity.seq <= RENUMBERED_APPLIED_SEQ)
    .map((identity) =>
      identity.seq === RENUMBERED_APPLIED_SEQ
        ? {
            seq: RENUMBERED_APPLIED_SEQ,
            fileName: RENUMBERED_APPLIED_FILE,
            sqlHash: RENUMBERED_SQL_HASH,
            scriptHash: null,
          }
        : identity,
    );
  writeFileSync(
    migrationRuntimeManifestPath(dbFilePath),
    `${JSON.stringify({ version: 1, legacyBaselineVersion: 105, migrations: appliedPrefix })}\n`,
    'utf8',
  );
}

function seedExactHistory(db: Database.Database, drizzleDir: string): void {
  const insert = db.prepare(
    `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const fileName of ['0000_init.sql', '0001_second.sql']) {
    insert.run(
      Number(fileName.slice(0, 4)),
      fileName,
      hashMigrationFile(path.join(drizzleDir, fileName)),
      123,
    );
  }
}

describe('renumbered applied migration repair', () => {
  function createRenumberedDrizzleDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-renumbered-migrations-'));
    cleanupDirs.push(dir);
    return dir;
  }

  /** 只放 104..110 的真实 canonical 文件；低序号不进 manifest，避免与真实文件撞号。 */
  function writeCanonicalTail(drizzleDir: string): void {
    copyMigrationFiles(drizzleDir, [
      '0104_schedule-model-harness.sql',
      '0105_context_window_runtime.sql',
      '0106_retain_all_recent_workdirs.sql',
      '0107_sudden_ultron.sql',
      '0108_lowly_scarlet_witch.sql',
      '0109_deep_wolfpack.sql',
      RENUMBERED_CANONICAL_FILE,
    ]);
  }

  it('accepts a registered renumber whose canonical content matches, then rewrites the manifest', () => {
    const drizzleDir = createRenumberedDrizzleDir();
    writeCanonicalTail(drizzleDir);
    // 落库现场只有旧的 0108_loose_puppet_master；登记表冻结的是 0110 的内容。
    expect(
      RENUMBERED_MANIFEST.migrations.at(-1)?.fileName,
    ).toBe(RENUMBERED_APPLIED_FILE);
    expect(hashMigrationFile(path.join(drizzleDir, RENUMBERED_CANONICAL_FILE))).toBe(
      RENUMBERED_SQL_HASH,
    );

    const dbFilePath = path.join(drizzleDir, 'shared.db');
    seedRenumberedManifest(dbFilePath, drizzleDir);

    expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 108)).not.toThrow();
    const repaired = JSON.parse(readFileSync(`${dbFilePath}.migration-runtime.json`, 'utf8')) as {
      legacyBaselineVersion: number;
      migrations: Array<{ seq: number; fileName: string }>;
    };
    expect(repaired.legacyBaselineVersion).toBe(105);
    expect(repaired.migrations.find((identity) => identity.seq === 108)?.fileName).toBe(
      '0108_lowly_scarlet_witch.sql',
    );
    expect(repaired.migrations.find((identity) => identity.seq === 110)?.fileName).toBe(
      RENUMBERED_CANONICAL_FILE,
    );
    // 幂等：第二次启动读到的已经是 canonical manifest。
    expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 108)).not.toThrow();
  });

  it('still fails closed when the canonical content is not the registered renumber target', () => {
    const drizzleDir = createRenumberedDrizzleDir();
    writeCanonicalTail(drizzleDir);
    // 同 seq 但内容被改写：登记只在旧身份指纹与 canonical 内容一致时放行。
    writeDrizzleFile(
      drizzleDir,
      RENUMBERED_CANONICAL_FILE,
      'ALTER TABLE `sessions` ADD `something_else` integer;\n',
    );
    const dbFilePath = path.join(drizzleDir, 'shared.db');
    seedRenumberedManifest(dbFilePath, drizzleDir);

    expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 108)).toThrow(
      /applied migration runtime identity (changed at seq 108 \(0108_loose_puppet_master\.sql\)|missing at seq 108)/,
    );
  });

  it('still fails closed when the checkout did not renumber the vacated seq', () => {
    const drizzleDir = createRenumberedDrizzleDir();
    writeCanonicalTail(drizzleDir);
    // 当前 checkout 不再把 0108 换成 0110（例如主干再次重排）：旧身份只能失败关闭。
    rmSync(path.join(drizzleDir, RENUMBERED_CANONICAL_FILE));
    const dbFilePath = path.join(drizzleDir, 'shared.db');
    seedRenumberedManifest(dbFilePath, drizzleDir);

    expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 108)).toThrow(
      /applied migration runtime identity (changed at seq 108 \(0108_loose_puppet_master\.sql\)|missing at seq 108)/,
    );
  });
});

describe('checkMigrationCompatibility', () => {
  it('accepts an exact schema version and migration history match', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);

      expect(checkMigrationCompatibility(db, drizzleDir)).toEqual({
        compatible: true,
        databaseVersion: 1,
        checkoutVersion: 1,
        issues: [],
      });
    } finally {
      db.close();
    }
  });

  it('rejects a database with pending checkout migrations', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(0);
    try {
      const first = '0000_init.sql';
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(0, first, hashMigrationFile(path.join(drizzleDir, first)), 123);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toEqual([
        'schema-version-behind',
        'history-entry-missing',
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects a database newer than the checkout', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(2);
    try {
      seedExactHistory(db, drizzleDir);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues).toEqual([
        { kind: 'schema-version-ahead', databaseVersion: 2, checkoutVersion: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects drifted, missing, or unexpected migration history entries', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(0, '0000_renamed.sql', 'wrong-hash', 123);
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(99, '0099_future.sql', 'future-hash', 123);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toEqual([
        'history-entry-mismatch',
        'history-entry-missing',
        'history-entry-unexpected',
      ]);
    } finally {
      db.close();
    }
  });

  it('fails closed when migration_history is unavailable', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1, false);
    try {
      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues[0]?.kind).toBe('history-unavailable');
    } finally {
      db.close();
    }
  });

  it.each(['abc', '1junk', '9007199254740992', '-1', '01'])(
    'fails closed for an invalid schema_version value: %s',
    (value) => {
      const drizzleDir = createDrizzleDir();
      const db = createDb(1);
      try {
        seedExactHistory(db, drizzleDir);
        db.prepare(`UPDATE migration_meta SET value=? WHERE key='schema_version'`).run(value);

        const report = checkMigrationCompatibility(db, drizzleDir);
        expect(report.compatible).toBe(false);
        expect(report.databaseVersion).toBe(-1);
        expect(report.issues.map((issue) => issue.kind)).toContain('history-unavailable');
      } finally {
        db.close();
      }
    },
  );

  it('includes companion TS scripts in the persisted runtime identity', () => {
    const drizzleDir = createDrizzleDir();
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);
    const scriptPath = path.join(scriptsDir, '0001_second.ts');
    writeFileSync(scriptPath, 'export function run() { return "first"; }\n', 'utf8');
    const dbFilePath = path.join(drizzleDir, 'shared.db');
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);
      prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1);
      expect(checkMigrationCompatibility(db, drizzleDir, dbFilePath).compatible).toBe(true);

      writeFileSync(scriptPath, 'export function run() { return "changed"; }\n', 'utf8');
      const report = checkMigrationCompatibility(db, drizzleDir, dbFilePath);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toContain('runtime-manifest-mismatch');
    } finally {
      db.close();
    }
  });

  it('never overwrites the identity of an already applied companion TS migration', () => {
    const drizzleDir = createDrizzleDir();
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);
    const scriptPath = path.join(scriptsDir, '0001_second.ts');
    writeFileSync(scriptPath, 'export function run() { return "applied-a"; }\n', 'utf8');
    const dbFilePath = path.join(drizzleDir, 'shared.db');

    prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1);
    writeFileSync(scriptPath, 'export function run() { return "checkout-b"; }\n', 'utf8');

    expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1)).toThrow(
      /applied migration runtime identity changed at seq 1/,
    );
  });

  it('normalizes the known bad 0062 companion identity back to canonical', () => {
    const sourceDrizzleDir = path.resolve(__dirname, '../../../../drizzle');
    const drizzleDir = mkdtempSync(path.join(tmpdir(), 'cindy-runtime-identity-repair-'));
    cleanupDirs.push(drizzleDir);
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);

    const fileName = '0062_flaky_mimic.sql';
    const sqlPath = path.join(drizzleDir, fileName);
    const scriptPath = path.join(scriptsDir, '0062_flaky_mimic.ts');
    const canonicalScript = readFileSync(
      path.join(sourceDrizzleDir, 'scripts', '0062_flaky_mimic.ts'),
      'utf8',
    );
    const badScript = canonicalScript.replace('@lizi/maker-scheduler', '@cindy/maker-scheduler');
    writeFileSync(sqlPath, readFileSync(path.join(sourceDrizzleDir, fileName), 'utf8'), 'utf8');
    writeFileSync(scriptPath, badScript, 'utf8');

    expect(hashMigrationFile(sqlPath)).toBe(
      '77b8741ac31c159eb422746c0165d102ad65693236c80d0ff055fd70cd43fe68',
    );
    expect(hashMigrationFile(scriptPath)).toBe(
      '0ea82003cac0419a4a483b0afc1743d6fdba0b50085104720d5b2561e721072d',
    );

    const dbFilePath = path.join(drizzleDir, 'shared.db');
    prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 62);
    writeFileSync(scriptPath, canonicalScript, 'utf8');
    expect(hashMigrationFile(scriptPath)).toBe(
      '0a72ba2d89237b4b7322ffbbeb644c94e01be7d159851e220f51c03edfa80b78',
    );

    const db = createDb(62);
    try {
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(62, fileName, hashMigrationFile(sqlPath), 123);

      expect(checkMigrationCompatibility(db, drizzleDir, dbFilePath).compatible).toBe(true);
      expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 62)).not.toThrow();
      const repaired = JSON.parse(readFileSync(`${dbFilePath}.migration-runtime.json`, 'utf8')) as {
        migrations: Array<{ scriptHash: string | null }>;
      };
      expect(repaired.migrations[0]?.scriptHash).toBe(
        '0a72ba2d89237b4b7322ffbbeb644c94e01be7d159851e220f51c03edfa80b78',
      );
    } finally {
      db.close();
    }
  });

  it('fails closed when the runtime identity has not been published by a primary', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);
      const report = checkMigrationCompatibility(
        db,
        drizzleDir,
        path.join(drizzleDir, 'missing.db'),
      );
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toContain('runtime-manifest-unavailable');
    } finally {
      db.close();
    }
  });
});
