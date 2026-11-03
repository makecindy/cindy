# Configuração local do desktop

A Cindy pode executar um agente local sem conta Cindy nem API de modelo paga.
Este guia usa os recursos já existentes no cliente; não instala um runtime nem
baixa pesos de modelo.

## Usar um modelo local

1. Na Cindy, abra **Settings → Providers → Add provider**.
2. Escolha **Ollama** e conecte o serviço local existente. O endereço padrão é
   `http://127.0.0.1:11434`. A Cindy também oferece instalação gerenciada do
   runtime; use-a somente se quiser instalar esse componente.
3. Nos detalhes do provedor Ollama, escolha um modelo para baixar e depois
   selecione-o ao iniciar uma tarefa. Os arquivos podem ocupar vários gigabytes;
   confira a licença do modelo e a memória disponível antes de baixar.
4. Se não quiser entrar numa conta Cindy, escolha **Skip Sign-In** na tela de
   entrada. Mantenha o provedor local selecionado em vez da Cindy AI ou de outro
   provedor hospedado.

Um serviço llama.cpp compatível com a API OpenAI também pode ser conectado em
**Settings → Providers → Add provider → llama.cpp**. O endereço
padrão documentado é `http://127.0.0.1:8080/v1`; use o endereço configurado no
serviço se for diferente. A opção gerenciada do llama.cpp é experimental e não
garante compatibilidade ou desempenho geral.

## Preservar memória, skills e plugins existentes

A memória, as skills aprendidas, os plugins instalados, as aprovações e as
preferências ficam associados ao perfil local da Cindy e/ou ao harness escolhido.
Use a mesma instalação e o mesmo perfil que já contêm seus dados. Não copie
pastas de perfil nem credenciais manualmente.

Um sandbox de desenvolvimento como
`pnpm restart:desktop:remote --region=global --isolated=@worktree` usa dados
separados. Ele serve para desenvolvimento seguro, mas não migra nem inclui
automaticamente a memória, as aprovações de plugins ou as preferências do app
instalado. Skills e plugins só funcionam quando instalados, habilitados,
aprovados e compatíveis com o harness selecionado. Plugins ainda podem acessar
serviços externos ou exigir credenciais.

## Iniciar o desktop a partir do código-fonte

O repositório requer Node.js 22.x, pnpm 10.x e Git LFS. Na raiz do checkout, o
comando suportado para iniciar o ambiente de desenvolvimento é:

```powershell
pnpm restart:desktop:remote --region=global --isolated=@worktree
```

Use `--region=cn` somente para a identidade de build da China continental. O
perfil de desenvolvimento é isolado dos dados do app instalado. A primeira
preparação de dependências usa `pnpm install`; o postinstall pode baixar
executáveis fixados dos runtimes de agentes e do Electron. Antes da instalação,
leia [`dev-rules/environment-setup.md`](dev-rules/environment-setup.md). Este
guia não instala dependências ou runtimes, não baixa modelos, não entra em contas
e não migra perfis.

## O que “somente local” significa (e o que não significa)

- A inferência do modelo local vai para o serviço local configurado, não para uma
  API paga. Mantenha o endereço em loopback, a menos que confie e configure
  deliberadamente outro host.
- **Pular login** desativa recursos que dependem do servidor Cindy, mas não torna
  o aplicativo inteiro offline: instalar ou atualizar software, baixar pesos de
  modelos e alguns recursos de marketplace ou plugins conectados requerem rede.
- Execução local não significa velocidade, contexto ou capacidade ilimitados.
  Os resultados dependem do modelo, da licença e dos recursos dele, da RAM/VRAM,
  do espaço em disco e do runtime. Isso não contorna cotas, licenças, controles
  de acesso ou limites de provedores.
