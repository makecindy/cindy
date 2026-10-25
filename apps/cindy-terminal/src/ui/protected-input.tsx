import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { InputHandoffSnapshot, InputHandoffSubmission, InputHandoffDecision } from '@cindy/device-link';
import { isInputHandoffActionable } from '@cindy/device-link';
import { Input, terminalText } from './input.js';
import { getMessages, type Locale } from './i18n.js';
import { useInputState } from './state.js';

const copy: Record<Locale,{title:string;send:string;picture:string;waiting:string}> = {
  en:{title:'Protected input',send:'Submit',picture:'Open this step in Cindy on a computer or phone.',waiting:'Waiting for the current step…'},
  'zh-CN':{title:'代输入',send:'提交',picture:'请在电脑或手机上的 Cindy 中打开这一步。',waiting:'正在等待当前步骤…'},
  'zh-TW':{title:'代輸入',send:'提交',picture:'請在電腦或手機上的 Cindy 中開啟這一步。',waiting:'正在等待目前步驟…'},
  ja:{title:'入力の代行',send:'送信',picture:'パソコンまたはスマートフォンの Cindy でこの手順を開いてください。',waiting:'現在の手順を待っています…'},
  ko:{title:'입력 대행',send:'제출',picture:'컴퓨터나 휴대폰의 Cindy에서 이 단계를 여세요.',waiting:'현재 단계를 기다리는 중…'},
};

const sourceWarnings = {
  "en": {
    "insecure": "This page doesn't use a secure connection. What you enter could be read by others.",
    "ip-address": "This page uses an IP address instead of a domain. Make sure it's the site you expect.",
    "local-host": "This page comes from a service on this computer. Make sure it's the app you expect.",
    "local-file": "This page is a local file. Make sure it's what you expect.",
    "punycode": "This address contains unusual characters and may imitate another site. Check it carefully.",
    "embedded-frame": "These fields are inside another site embedded in the page. Make sure the source is trusted."
  },
  "zh-CN": {
    "insecure": "这个页面没有使用安全连接，输入的内容可能被他人读取。",
    "ip-address": "这个页面使用 IP 地址而不是域名，请确认它是你预期的网站。",
    "local-host": "这个页面来自本机服务，请确认它是你预期的程序。",
    "local-file": "这个页面是本地文件，请确认它是你预期的内容。",
    "punycode": "这个网址包含特殊字符，可能在冒充其他网站，请仔细核对。",
    "embedded-frame": "输入框位于嵌入的其他网站中，请确认来源可信。"
  },
  "zh-TW": {
    "insecure": "這個頁面沒有使用安全連線，輸入的內容可能被他人讀取。",
    "ip-address": "這個頁面使用 IP 位址而不是網域名稱，請確認它是你預期的網站。",
    "local-host": "這個頁面來自本機服務，請確認它是你預期的程式。",
    "local-file": "這個頁面是本機檔案，請確認它是你預期的內容。",
    "punycode": "這個網址包含特殊字元，可能在冒充其他網站，請仔細核對。",
    "embedded-frame": "輸入框位於嵌入的其他網站中，請確認來源可信。"
  },
  "ja": {
    "insecure": "このページは安全な接続を使っていません。入力内容が他人に読まれる可能性があります。",
    "ip-address": "このページはドメインではなく IP アドレスを使っています。想定したサイトか確認してください。",
    "local-host": "このページはこのコンピュータ上のサービスから表示されています。想定したアプリか確認してください。",
    "local-file": "このページはローカルファイルです。想定した内容か確認してください。",
    "punycode": "このアドレスには特殊な文字が含まれ、別のサイトを装っている可能性があります。よく確認してください。",
    "embedded-frame": "入力欄はページに埋め込まれた別サイトの中にあります。提供元が信頼できるか確認してください。"
  },
  "ko": {
    "insecure": "이 페이지는 보안 연결을 사용하지 않습니다. 입력한 내용이 다른 사람에게 노출될 수 있습니다.",
    "ip-address": "이 페이지는 도메인 대신 IP 주소를 사용합니다. 예상한 사이트인지 확인하세요.",
    "local-host": "이 페이지는 이 컴퓨터의 서비스에서 제공됩니다. 예상한 앱인지 확인하세요.",
    "local-file": "이 페이지는 로컬 파일입니다. 예상한 내용인지 확인하세요.",
    "punycode": "이 주소에는 특수 문자가 포함되어 다른 사이트를 사칭할 수 있습니다. 자세히 확인하세요.",
    "embedded-frame": "입력란이 페이지에 삽입된 다른 사이트 안에 있습니다. 출처를 신뢰할 수 있는지 확인하세요."
  }
};

export function ProtectedInputView({request,locale,busy,submit,decide,back}: {
  request:InputHandoffSnapshot;locale:Locale;busy:boolean;
  submit(value:InputHandoffSubmission):void;decide(value:InputHandoffDecision):void;back():void;
}) {
  const text=copy[locale],t=getMessages(locale);
  const fields=request.controls.filter(control=>control.kind==='text');
  const [index,setIndex,indexNow]=useInputState(0);
  const [values,setValues,valuesNow]=useInputState<Record<string,string>>({});
  const [confirm,setConfirm]=useState(false);
  const actionable=isInputHandoffActionable(request)&&!request.picture;
  useEffect(()=>()=>{ for(const key of Object.keys(valuesNow.current))delete valuesNow.current[key]; },[]);
  useInput((input,key)=>{
    if(busy||key.eventType==='release')return;
    if(key.escape){back();return;}
    if(key.ctrl&&input==='x'){setValues({});decide({kind:'input_handoff',action:'cancel',expectedRevision:request.revision});return;}
    if(confirm&&key.return){const answer={...valuesNow.current};setValues({});setConfirm(false);submit({expectedRevision:request.revision,values:answer,action:{kind:'submit'}});}
  },{isActive:!busy});
  const field=fields[index];
  const next=(value:string)=>{
    const field=fields[indexNow.current];if(!field)return;
    setValues(current=>({...current,[field.id]:value}));
    if(indexNow.current+1<fields.length)setIndex(indexNow.current+1);else setConfirm(true);
  };
  return <Box flexDirection="column" gap={1}>
    <Text bold>{text.title}</Text>
    <Text>{terminalText(request.purpose)}</Text>
    <Text>{terminalText(request.source.app)}{request.source.origin?` · ${terminalText(request.source.origin)}`:''}</Text>
    {request.source.warning&&<Text color="yellow">{sourceWarnings[locale][request.source.warning]}</Text>}
    {request.command&&<Text>{terminalText(request.command)}</Text>}
    {request.controls.filter(control=>control.kind==='note').map((control,index)=><Text key={index} color="yellow">{terminalText(control.text)}</Text>)}
    {request.picture?<Text>{text.picture}</Text>:!actionable?<Text dimColor>{text.waiting}</Text>:confirm?<Text bold>Enter · {text.send}</Text>:field&&<Box flexDirection="column" gap={1}>
      {(field.label||fields.length>1)&&<Text>{terminalText(field.label)}{fields.length>1?` · ${index+1}/${fields.length}`:''}</Text>}
      <Input key={field.id} value={values[field.id]??''} secret active={!busy} onChange={value=>setValues(current=>({...current,[field.id]:value}))} onSubmit={next} onCancel={back}/>
    </Box>}
    <Text dimColor>Esc · {t.back}   Ctrl+X · {t.cancel}</Text>
  </Box>;
}
