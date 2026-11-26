"""Use unmodified Arc and Papirus resources; configure only native Xfce properties."""
import configparser,pathlib,xml.etree.ElementTree as ET
home=pathlib.Path.home();marker=home/'.config/cindy-desktop/appearance-stock-arc-v2'
if marker.exists():raise SystemExit(0)
config=home/'.config/xfce4/xfconf/xfce-perchannel-xml'
config.mkdir(parents=True,exist_ok=True)
def update(channel,values):
 p=config/(channel+'.xml');root=ET.parse(p).getroot() if p.exists() else ET.Element('channel',{'name':channel,'version':'1.0'})
 for path,t,value in values:
  node=root
  for name in path.strip('/').split('/'):
   child=next((n for n in node if n.tag=='property' and n.get('name')==name),None)
   if child is None:child=ET.SubElement(node,'property',{'name':name,'type':'empty'})
   node=child
  node.set('type',t);node.set('value',str(value))
 tmp=p.with_suffix('.tmp');ET.ElementTree(root).write(tmp,encoding='UTF-8',xml_declaration=True);tmp.chmod(0o600);tmp.replace(p)
update('xfwm4',[('general/theme','string','Arc')])
update('xsettings',[('Net/ThemeName','string','Arc'),('Net/IconThemeName','string','Papirus')])
update('xfce4-panel',[
 ('panels/panel-1/position','string','p=0;x=640;y=764'),('panels/panel-1/size','uint','48'),
 ('panels/panel-1/icon-size','uint','32'),('panels/panel-1/length','uint','1'),
 ('panels/panel-1/length-adjust','bool','true'),('panels/panel-1/position-locked','bool','true'),
 ('plugins/plugin-1/expand','bool','false'),('plugins/plugin-1/grouping','uint','1'),
 ('plugins/plugin-1/show-labels','bool','false')])
# GTK defaults are available before xfsettingsd claims the XSettings selection.
# This also gives early-starting panel widgets the unmodified packaged theme.
gtk=home/'.config/gtk-3.0/settings.ini'
gtk.parent.mkdir(parents=True,exist_ok=True)
settings=configparser.ConfigParser(interpolation=None)
settings.optionxform=str
if gtk.exists():settings.read(gtk)
if not settings.has_section('Settings'):settings.add_section('Settings')
settings['Settings']['gtk-theme-name']='Arc'
settings['Settings']['gtk-icon-theme-name']='Papirus'
tmp=gtk.with_suffix('.tmp')
with tmp.open('w') as stream:settings.write(stream)
tmp.chmod(0o600);tmp.replace(gtk)
css=home/'.config/gtk-3.0/gtk.css'
if css.exists():
 content=css.read_text()
 block='\n/* Cindy desktop appearance v1 */\n@import url("/usr/local/share/cindy/appearance/panel.css");\n'
 content=content.replace(block,'')
 # Remove only Cindy's own import of this file; preserve any independent user CSS.
 if '/usr/local/share/cindy/appearance/panel.css' in content:raise RuntimeError('Unexpected existing panel CSS import; preserve for review')
 css.write_text(content);css.chmod(0o600)
marker.parent.mkdir(parents=True,exist_ok=True);marker.write_text('Arc + Papirus, unmodified packaged themes\n');marker.chmod(0o600)
