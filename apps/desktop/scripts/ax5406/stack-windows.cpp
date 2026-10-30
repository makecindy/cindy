// Offline minidump analysis through Microsoft's DbgEng. Never attaches to a live process.
// Build using the VS x64 tools + Windows SDK: cl /EHsc stack-windows.cpp /link dbgeng.lib
// Usage: stack-windows.exe dump.dmp "srv*C:\task-cache*https://symbols.electronjs.org;srv*C:\task-cache*https://msdl.microsoft.com/download/symbols"
#include <windows.h>
#include <dbgeng.h>
#include <cstdio>

class DebugOutput final : public IDebugOutputCallbacks {
 public:
  STDMETHOD(QueryInterface)(REFIID iid, PVOID* out) override {
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IDebugOutputCallbacks)) {
      *out = static_cast<IDebugOutputCallbacks*>(this); return S_OK;
    }
    *out = nullptr; return E_NOINTERFACE;
  }
  STDMETHOD_(ULONG, AddRef)() override { return 1; }
  STDMETHOD_(ULONG, Release)() override { return 1; }
  STDMETHOD(Output)(ULONG, PCSTR text) override { std::fputs(text, stdout); std::fflush(stdout); return S_OK; }
};
int wmain(int argc, wchar_t** argv) {
  if (argc != 3) return 2;
  IDebugClient4* client = nullptr;
  IDebugControl* control = nullptr;
  IDebugSymbols3* symbols = nullptr;
  HRESULT hr = DebugCreate(__uuidof(IDebugClient4), reinterpret_cast<void**>(&client));
  if (FAILED(hr)) return 3;
  DebugOutput output;
  client->SetOutputCallbacks(&output);
  client->QueryInterface(__uuidof(IDebugControl), reinterpret_cast<void**>(&control));
  client->QueryInterface(__uuidof(IDebugSymbols3), reinterpret_cast<void**>(&symbols));
  if (!control || !symbols) return 4;
  symbols->SetSymbolPathWide(argv[2]);
  hr = client->OpenDumpFileWide(argv[1], 0);
  if (SUCCEEDED(hr)) hr = control->WaitForEvent(0, INFINITE);
  if (SUCCEEDED(hr)) {
    control->Execute(DEBUG_OUTCTL_THIS_CLIENT, ".ecxr; kv 100; lmv a @rip; ln @rip; ub @rip L2; u @rip L2", DEBUG_EXECUTE_DEFAULT);
  } else std::printf("DbgEng failed: 0x%08lx\n", hr);
  client->EndSession(DEBUG_END_PASSIVE);
  symbols->Release(); control->Release(); client->SetOutputCallbacks(nullptr); client->Release();
  return FAILED(hr) ? 5 : 0;
}
