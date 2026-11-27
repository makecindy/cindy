"""Seed cloud Dock pins once, without writing ~/.local/share, which may not be writable."""
import pathlib,subprocess
home=pathlib.Path.home();config=home/'.config';marker=config/'cindy-desktop/plank-apps-v3'
if marker.exists():raise SystemExit(0)
for binary in ['/usr/bin/xfce4-terminal','/opt/google/chrome/chrome','/usr/local/bin/cindy-dock-terminal','/usr/local/bin/cindy-dock-chrome']:
 if not pathlib.Path(binary).is_file():raise RuntimeError('DOCK_APPLICATION_MISSING:'+binary)
launchers=config/'plank/dock1/launchers';launchers.mkdir(parents=True,exist_ok=True)
backup=config/'cindy-desktop/plank-apps-v3-before';backup.mkdir(parents=True,exist_ok=True)
def write(p,text):
 temp=p.with_suffix(p.suffix+'.tmp');temp.write_text(text);temp.chmod(0o600);temp.replace(p)
for name in ['terminal','chrome']:
 desktop=pathlib.Path('/usr/share/applications')/('com.cindy.cloud-'+name+'.desktop');assert desktop.is_file()
 item=launchers/('cindy-'+name+'.dockitem')
 if item.exists() and not (backup/item.name).exists():write(backup/item.name,item.read_text())
 write(item,'[PlankDockItemPreferences]\nLauncher='+desktop.as_uri()+'\n')
schema='net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/'
# Homes with this marker already have 40px/nozoom; preserve later preferences.
if not (config/'cindy-desktop/plank-apps-v2').exists():
 for key,value in {'icon-size':'40','zoom-enabled':'false'}.items():subprocess.run(['gsettings','set',schema,key,value],check=True,timeout=10)
marker.parent.mkdir(parents=True,exist_ok=True);write(marker,'System desktop entries; Plank Matte; terminal and Chrome pinned\n')
