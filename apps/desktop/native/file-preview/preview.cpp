// The Windows Shell owns the view, preview-handler selection and trust policy.
// This helper has its own STA and message loop, outside Electron main.
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shlguid.h>
#include <new>

class Site final : public IServiceProvider, public IExplorerPaneVisibility, public IExplorerBrowserEvents {
public:
    IExplorerBrowser* browser = nullptr;
    PCIDLIST_ABSOLUTE target = nullptr;
    bool selected = false;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid == IID_IUnknown || iid == IID_IServiceProvider) *out = static_cast<IServiceProvider*>(this);
        else if (iid == IID_IExplorerPaneVisibility) *out = static_cast<IExplorerPaneVisibility*>(this);
        else if (iid == IID_IExplorerBrowserEvents) *out = static_cast<IExplorerBrowserEvents*>(this);
        else return E_NOINTERFACE;
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG remaining = --refs;
        if (!remaining) delete this;
        return remaining;
    }
    HRESULT STDMETHODCALLTYPE QueryService(REFGUID service, REFIID iid, void** out) override {
        if (service == SID_ExplorerPaneVisibility) return QueryInterface(iid, out);
        if (out) *out = nullptr;
        return E_NOINTERFACE;
    }
    HRESULT STDMETHODCALLTYPE GetPaneState(REFEXPLORERPANE pane, EXPLORERPANESTATE* state) override {
        *state = pane == EP_PreviewPane ? EPS_FORCE | EPS_DEFAULT_ON : EPS_FORCE | EPS_DEFAULT_OFF;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE OnNavigationPending(PCIDLIST_ABSOLUTE) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnViewCreated(IShellView*) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnNavigationFailed(PCIDLIST_ABSOLUTE) override { PostQuitMessage(1); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnNavigationComplete(PCIDLIST_ABSOLUTE) override {
        IShellView* view = nullptr;
        if (target && SUCCEEDED(browser->GetCurrentView(IID_PPV_ARGS(&view)))) {
            selected = SUCCEEDED(view->SelectItem(ILFindLastID(target),
                SVSI_SELECT | SVSI_FOCUSED | SVSI_ENSUREVISIBLE | SVSI_DESELECTOTHERS));
            view->Release();
            target = nullptr;
        }
        if (!selected) PostQuitMessage(1);
        return S_OK;
    }
private:
    ULONG refs = 1;
};

static LRESULT CALLBACK windowProc(HWND window, UINT msg, WPARAM w, LPARAM l) {
    auto browser = reinterpret_cast<IExplorerBrowser*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (msg == WM_SIZE && browser) {
        RECT bounds;
        GetClientRect(window, &bounds);
        browser->SetRect(nullptr, bounds);
    }
    if (msg == WM_CLOSE) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, msg, w, l);
}

static int showPreview(HWND owner, PCWSTR file) {
    PIDLIST_ABSOLUTE item = nullptr;
    if (FAILED(SHParseDisplayName(file, nullptr, &item, 0, nullptr))) return 1;
    PIDLIST_ABSOLUTE parent = ILCloneFull(item);
    IExplorerBrowser* browser = nullptr;
    Site* site = new(std::nothrow) Site();
    DWORD cookie = 0;
    bool initialized = false;
    bool advised = false;
    int result = 1;
    WNDCLASSW wc{};
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpfnWndProc = windowProc;
    wc.lpszClassName = L"CindyShellPreview";
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    RegisterClassW(&wc);
    HWND window = CreateWindowExW(0, wc.lpszClassName, PathFindFileNameW(file),
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, CW_USEDEFAULT, CW_USEDEFAULT, 960, 640,
        owner, nullptr, wc.hInstance, nullptr);
    if (site && window && parent && ILRemoveLastID(parent) &&
        SUCCEEDED(CoCreateInstance(CLSID_ExplorerBrowser, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&browser)))) {
        site->browser = browser;
        site->target = item;
        IObjectWithSite* host = nullptr;
        if (SUCCEEDED(browser->QueryInterface(IID_PPV_ARGS(&host)))) {
            host->SetSite(static_cast<IServiceProvider*>(site));
            host->Release();
        }
        RECT bounds;
        GetClientRect(window, &bounds);
        FOLDERSETTINGS settings{FVM_DETAILS, FWF_SINGLESEL | FWF_NOCLIENTEDGE};
        browser->SetOptions(EBO_SHOWFRAMES | EBO_NOPERSISTVIEWSTATE | EBO_NAVIGATEONCE);
        initialized = SUCCEEDED(browser->Initialize(window, &bounds, &settings));
        advised = initialized && SUCCEEDED(browser->Advise(site, &cookie));
        if (advised && SUCCEEDED(browser->BrowseToIDList(parent, SBSP_ABSOLUTE))) {
            SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(browser));
            ShowWindow(window, SW_SHOW);
            MSG msg;
            while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
                if (msg.message == WM_KEYDOWN && msg.wParam == VK_ESCAPE) break;
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            result = site->selected ? 0 : 1;
        }
    }
    if (browser) {
        SetWindowLongPtrW(window, GWLP_USERDATA, 0);
        if (advised) browser->Unadvise(cookie);
        if (initialized) browser->Destroy();
        browser->Release();
    }
    if (site) site->Release();
    if (window) DestroyWindow(window);
    CoTaskMemFree(parent);
    CoTaskMemFree(item);
    return result;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    int count = 0;
    PWSTR* args = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!args || count != 3) { LocalFree(args); return 1; }
    HRESULT hr = OleInitialize(nullptr);
    int result = 1;
    if (SUCCEEDED(hr)) {
        HWND owner = reinterpret_cast<HWND>(static_cast<UINT_PTR>(_wcstoui64(args[1], nullptr, 10)));
        result = showPreview(owner, args[2]);
        OleUninitialize();
    }
    LocalFree(args);
    return result;
}
