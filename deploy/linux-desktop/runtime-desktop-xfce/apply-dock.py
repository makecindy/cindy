"""Apply native Xfce and Plank settings once per home. Preserve unrelated user settings."""
import pathlib,subprocess,xml.etree.ElementTree as ET
home=pathlib.Path.home(); config=home/'.config'; marker=config/'cindy-desktop/plank-matte-v1'
if marker.exists():raise SystemExit(0)
def update(channel,values):
 p=config/'xfce4/xfconf/xfce-perchannel-xml'/(channel+'.xml')
 p.parent.mkdir(parents=True,exist_ok=True)
 root=ET.parse(p).getroot() if p.exists() else ET.Element('channel',name=channel,version='1.0')
 for path,t,value in values:
  node=root
  for name in path.strip('/').split('/'):
   child=next((n for n in node if n.tag=='property' and n.get('name')==name),None)
   if child is None:child=ET.SubElement(node,'property',name=name,type='empty')
   node=child
  node.set('type',t);node.set('value',str(value))
 tmp=p.with_suffix('.tmp');ET.ElementTree(root).write(tmp,encoding='UTF-8',xml_declaration=True);tmp.chmod(0o600);tmp.replace(p)
update('xfwm4',[('general/theme','string','Arc'),('general/use_compositing','bool','true'),('general/show_dock_shadow','bool','false')])
values=[('desktop-icons/style','int','0'),('desktop-menu/show','bool','false'),('windowlist-menu/show','bool','false')]
for workspace in range(4):
 prefix=f'backdrop/screen0/monitorscreen/workspace{workspace}/'
 values += [(prefix+'last-image','string','/usr/share/backgrounds/xfce/xfce-blue.jpg'),(prefix+'image-style','int','5'),(prefix+'color-style','int','0')]
update('xfce4-desktop',values)
schema='net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/'
for key,value in {'theme':'Matte','auto-pinning':'false','show-dock-item':'false','hide-mode':'none','icon-size':'48','zoom-enabled':'true','zoom-percent':'120','lock-items':'true','alignment':'center','position':'bottom','pinned-only':'false'}.items():
 subprocess.run(['gsettings','set',schema,key,value],check=True,timeout=10)
launchers=config/'plank/dock1/launchers';launchers.mkdir(parents=True,exist_ok=True)
# No pinned app launchers. Plank owns dock-items; never overwrite that array.
clock=launchers/'clock-1.dockitem'
if not clock.exists():clock.write_text('[PlankDockItemPreferences]\nLauncher=docklet://clock\n\n[DockyClockPreferences]\nShowMilitary=false\nShowDigital=false\nShowDate=false\n');clock.chmod(0o600)
marker.parent.mkdir(parents=True,exist_ok=True);marker.write_text('Plank Matte, Arc, Papirus; packaged resources\n');marker.chmod(0o600)
