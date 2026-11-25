# Settings guidance overlay

Appends `settings.md` to the system prompt of every agent engine on a cloud instance. It
tells the model how to use and explain the `cindy_helper` settings tools; it grants
nothing and changes no tool.

Claude, Codex and Pi read their prompt through `withCloudPluginOauthPrompt` in
`plugin-oauth/prompt.ts`. The overlay changes only that getter, which decides on every
read whether this is a cloud instance; other prompts keep their exact bytes. The three
places that build engine configs are checked but not changed, so losing one engine fails
the build.

```sh
CINDY_TEST_CLIENT_SOURCE="$PWD" node --test deploy/linux-desktop/runtime-guidance/*.test.mjs
```

The tests run the transformed getter. They do not show how a model follows the text.
