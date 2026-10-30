// Safari invokes this only after the user selects Cindy in the share sheet.
// Keep the page untouched. Include the selected passage, never form fields.
var ExtensionPreprocessingJS = {
  run: function (args) {
    args.completionFunction({
      title: document.title || '',
      url: document.location.href,
      selection: String(window.getSelection() || ''),
    });
  },
};
