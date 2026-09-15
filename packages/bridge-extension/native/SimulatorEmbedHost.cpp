#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <dwmapi.h>
#include <shlwapi.h>
#include <tlhelp32.h>
#include <d3d11.h>
#include <dxgi1_3.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

using namespace std::chrono_literals;
using namespace winrt;
namespace capture = winrt::Windows::Graphics::Capture;
namespace directx = winrt::Windows::Graphics::DirectX;
namespace direct3d = winrt::Windows::Graphics::DirectX::Direct3D11;

namespace
{
constexpr UINT WmAppUpdateBounds = WM_APP + 1;
constexpr UINT WmAppUpdateHighlight = WM_APP + 2;
constexpr DWORD WindowEventFlags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;

struct Layout
{
    double x{};
    double y{};
    double width{};
    double height{};
    double viewportWidth{};
    double viewportHeight{};
};

struct Highlight
{
    double viewportWidth{};
    double viewportHeight{};
    std::array<double, 8> points{};
    double anchorX{};
    double anchorY{};
};

struct SourceGeometry
{
    UINT left{};
    UINT top{};
    UINT width{};
    UINT height{};
};

HWND parentWindow{};
HWND simulatorWindow{};
HWND embeddedWindow{};
HWND highlightWindow{};
RECT originalSimulatorRect{};
LONG_PTR originalSimulatorParent{};
LONG_PTR originalSimulatorStyle{};
LONG_PTR originalSimulatorExStyle{};
bool simulatorPrepared{};
DWORD parentProcessId{};
DWORD simulatorProcessId{};
HWINEVENTHOOK destroyHook{};

std::mutex stateMutex;
Layout latestLayout{};
std::optional<Highlight> latestHighlight;
std::unordered_set<int> heldKeys;
int pointerButtons{};
int lastPointerX{};
int lastPointerY{};

std::mutex outputMutex;
std::mutex captureMutex;
std::mutex firstFrameMutex;
std::condition_variable firstFrameCondition;
std::uint64_t presentedFrames{};
bool captureFailed{};
std::string captureError;
std::atomic<bool> closing{};

com_ptr<ID3D11Device> d3dDevice;
com_ptr<ID3D11DeviceContext> d3dContext;
com_ptr<IDXGISwapChain1> swapChain;
direct3d::IDirect3DDevice winrtDevice{nullptr};
capture::GraphicsCaptureItem captureItem{nullptr};
capture::Direct3D11CaptureFramePool framePool{nullptr};
capture::GraphicsCaptureSession captureSession{nullptr};
event_token frameToken{};
event_token closedToken{};
winrt::Windows::Graphics::SizeInt32 captureSize{};
UINT swapChainWidth{};
UINT swapChainHeight{};

void WriteLine(std::string const& value)
{
    std::lock_guard<std::mutex> lock(outputMutex);
    std::cout << value << std::endl;
}

void WriteError(std::string const& value)
{
    std::lock_guard<std::mutex> lock(outputMutex);
    std::cerr << "ERROR|" << value << std::endl;
}

std::string WideToUtf8(std::wstring_view value)
{
    if (value.empty()) return {};
    int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) return "WINDOWS_ERROR";
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

[[noreturn]] void ThrowLastError(char const* code)
{
    throw std::runtime_error(std::string(code) + ":" + std::to_string(GetLastError()));
}

void CheckWin32(BOOL result, char const* code)
{
    if (!result) ThrowLastError(code);
}

void SetWindowLongPtrChecked(HWND window, int index, LONG_PTR value, char const* code)
{
    SetLastError(0);
    LONG_PTR previous = SetWindowLongPtrW(window, index, value);
    if (!previous && GetLastError()) ThrowLastError(code);
}

std::vector<std::string> Split(std::string const& value, char delimiter)
{
    std::vector<std::string> parts;
    size_t start = 0;
    while (true)
    {
        size_t end = value.find(delimiter, start);
        parts.push_back(value.substr(start, end == std::string::npos ? std::string::npos : end - start));
        if (end == std::string::npos) return parts;
        start = end + 1;
    }
}

std::vector<std::wstring> SplitTitles(std::wstring const& value)
{
    std::vector<std::wstring> titles;
    size_t start = 0;
    while (start <= value.size())
    {
        size_t end = value.find(L'\n', start);
        std::wstring title = value.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
        if (!title.empty()) titles.push_back(std::move(title));
        if (end == std::wstring::npos) break;
        start = end + 1;
    }
    return titles;
}

double ParseFinite(std::wstring const& value, char const* code)
{
    size_t consumed = 0;
    double parsed = std::stod(value, &consumed);
    if (consumed != value.size() || !std::isfinite(parsed)) throw std::runtime_error(code);
    return parsed;
}

double ParseFinite(std::string const& value, char const* code)
{
    size_t consumed = 0;
    double parsed = std::stod(value, &consumed);
    if (consumed != value.size() || !std::isfinite(parsed)) throw std::runtime_error(code);
    return parsed;
}

DWORD ParseProcessId(std::wstring const& value, bool allowZero)
{
    size_t consumed = 0;
    unsigned long parsed = std::stoul(value, &consumed);
    if (consumed != value.size() || (!allowZero && parsed == 0)) throw std::runtime_error("INVALID_PROCESS_ID");
    return static_cast<DWORD>(parsed);
}

Layout ParseLayout(wchar_t** values, int offset)
{
    Layout result{
        ParseFinite(values[offset], "INVALID_BOUNDS"),
        ParseFinite(values[offset + 1], "INVALID_BOUNDS"),
        ParseFinite(values[offset + 2], "INVALID_BOUNDS"),
        ParseFinite(values[offset + 3], "INVALID_BOUNDS"),
        ParseFinite(values[offset + 4], "INVALID_BOUNDS"),
        ParseFinite(values[offset + 5], "INVALID_BOUNDS")
    };
    if (result.x < 0 || result.y < 0 || result.width <= 0 || result.height <= 0
        || result.viewportWidth <= 0 || result.viewportHeight <= 0
        || result.x + result.width > result.viewportWidth + 2
        || result.y + result.height > result.viewportHeight + 2)
    {
        throw std::runtime_error("INVALID_BOUNDS");
    }
    return result;
}

Layout ParseLayout(std::vector<std::string> const& values, size_t offset)
{
    Layout result{
        ParseFinite(values[offset], "INVALID_BOUNDS"),
        ParseFinite(values[offset + 1], "INVALID_BOUNDS"),
        ParseFinite(values[offset + 2], "INVALID_BOUNDS"),
        ParseFinite(values[offset + 3], "INVALID_BOUNDS"),
        ParseFinite(values[offset + 4], "INVALID_BOUNDS"),
        ParseFinite(values[offset + 5], "INVALID_BOUNDS")
    };
    if (result.x < 0 || result.y < 0 || result.width <= 0 || result.height <= 0
        || result.viewportWidth <= 0 || result.viewportHeight <= 0
        || result.x + result.width > result.viewportWidth + 2
        || result.y + result.height > result.viewportHeight + 2)
    {
        throw std::runtime_error("INVALID_BOUNDS");
    }
    return result;
}

Highlight ParseHighlight(std::vector<std::string> const& values)
{
    if (values.size() != 13) throw std::runtime_error("INVALID_HIGHLIGHT_COMMAND");
    Highlight result;
    result.viewportWidth = ParseFinite(values[1], "INVALID_HIGHLIGHT_VIEWPORT");
    result.viewportHeight = ParseFinite(values[2], "INVALID_HIGHLIGHT_VIEWPORT");
    if (result.viewportWidth <= 0 || result.viewportHeight <= 0) throw std::runtime_error("INVALID_HIGHLIGHT_VIEWPORT");
    for (size_t index = 0; index < result.points.size(); ++index)
    {
        result.points[index] = ParseFinite(values[index + 3], "INVALID_HIGHLIGHT_POINT");
    }
    result.anchorX = ParseFinite(values[11], "INVALID_HIGHLIGHT_ANCHOR");
    result.anchorY = ParseFinite(values[12], "INVALID_HIGHLIGHT_ANCHOR");
    return result;
}

std::wstring ReadWindowTitle(HWND window)
{
    int length = GetWindowTextLengthW(window);
    std::wstring title(static_cast<size_t>(std::max(0, length)), L'\0');
    if (length > 0) GetWindowTextW(window, title.data(), length + 1);
    return title;
}

struct WindowSearch
{
    DWORD processId{};
    std::vector<std::wstring> const* titles{};
    HWND match{};
    HWND fallback{};
    long long fallbackArea{-1};
};

BOOL CALLBACK FindWindowCallback(HWND window, LPARAM parameter)
{
    auto& search = *reinterpret_cast<WindowSearch*>(parameter);
    DWORD owner = 0;
    GetWindowThreadProcessId(window, &owner);
    if (owner != search.processId || !IsWindowVisible(window)) return TRUE;
    RECT rect{};
    long long area = GetWindowRect(window, &rect)
        ? std::max(0LL, static_cast<long long>(rect.right - rect.left) * (rect.bottom - rect.top))
        : 0;
    if (area > search.fallbackArea)
    {
        search.fallback = window;
        search.fallbackArea = area;
    }
    std::wstring title = ReadWindowTitle(window);
    for (auto const& candidate : *search.titles)
    {
        if (!candidate.empty() && StrStrIW(title.c_str(), candidate.c_str()))
        {
            search.match = window;
            return FALSE;
        }
    }
    return TRUE;
}

HWND FindWindowForProcess(DWORD processId, std::vector<std::wstring> const& titles)
{
    WindowSearch search{processId, &titles};
    EnumWindows(FindWindowCallback, reinterpret_cast<LPARAM>(&search));
    return search.match ? search.match : search.fallback;
}

HWND WaitForWindow(DWORD processId, std::vector<std::wstring> const& titles, std::chrono::milliseconds timeout)
{
    auto deadline = std::chrono::steady_clock::now() + timeout;
    do
    {
        if (HWND found = FindWindowForProcess(processId, titles)) return found;
        std::this_thread::sleep_for(50ms);
    } while (std::chrono::steady_clock::now() < deadline);
    throw std::runtime_error("WINDOW_NOT_FOUND:" + std::to_string(processId));
}

bool IsSimulatorProcess(DWORD processId, DWORD expectedParent)
{
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return false;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    bool matched = false;
    if (Process32FirstW(snapshot, &entry))
    {
        do
        {
            if (entry.th32ProcessID == processId)
            {
                matched = entry.th32ParentProcessID == expectedParent
                    && _wcsicmp(entry.szExeFile, L"SimulatorApp-Win32.exe") == 0;
                break;
            }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return matched;
}

DWORD FindSimulatorProcessId(DWORD expectedParent)
{
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    DWORD found = 0;
    if (Process32FirstW(snapshot, &entry))
    {
        do
        {
            if (entry.th32ParentProcessID == expectedParent
                && _wcsicmp(entry.szExeFile, L"SimulatorApp-Win32.exe") == 0)
            {
                found = std::max(found, entry.th32ProcessID);
            }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return found;
}

HWND WaitForSimulatorWindow(DWORD requestedProcessId, DWORD ownerProcessId, std::chrono::milliseconds timeout)
{
    auto deadline = std::chrono::steady_clock::now() + timeout;
    std::vector<std::wstring> titles{L"Cocos Simulator"};
    do
    {
        DWORD candidate = requestedProcessId ? requestedProcessId : FindSimulatorProcessId(ownerProcessId);
        if (candidate && IsSimulatorProcess(candidate, ownerProcessId))
        {
            if (HWND found = FindWindowForProcess(candidate, titles))
            {
                simulatorProcessId = candidate;
                return found;
            }
        }
        std::this_thread::sleep_for(50ms);
    } while (std::chrono::steady_clock::now() < deadline);
    throw std::runtime_error("SIMULATOR_WINDOW_NOT_FOUND:" + std::to_string(requestedProcessId));
}

int ScaleCoordinate(double value, double viewport, int destination)
{
    return static_cast<int>(std::lround(std::clamp(value, 0.0, viewport) * destination / std::max(1.0, viewport)));
}

void PaintHighlight(HWND window)
{
    PAINTSTRUCT paint{};
    HDC dc = BeginPaint(window, &paint);
    RECT client{};
    GetClientRect(window, &client);

    std::optional<Highlight> current;
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        current = latestHighlight;
    }
    int width = client.right - client.left;
    int height = client.bottom - client.top;
    if (current && width > 0 && height > 0)
    {
        POINT points[5]{};
        for (size_t index = 0; index < 4; ++index)
        {
            points[index].x = ScaleCoordinate(current->points[index * 2], current->viewportWidth, width);
            points[index].y = ScaleCoordinate(current->points[index * 2 + 1], current->viewportHeight, height);
        }
        points[4] = points[0];
        HPEN pen = CreatePen(PS_SOLID, 6, RGB(118, 216, 192));
        HGDIOBJ oldPen = SelectObject(dc, pen);
        HGDIOBJ oldBrush = SelectObject(dc, GetStockObject(HOLLOW_BRUSH));
        Polyline(dc, points, ARRAYSIZE(points));
        HBRUSH anchorBrush = CreateSolidBrush(RGB(255, 255, 255));
        SelectObject(dc, anchorBrush);
        int anchorX = ScaleCoordinate(current->anchorX, current->viewportWidth, width);
        int anchorY = ScaleCoordinate(current->anchorY, current->viewportHeight, height);
        Ellipse(dc, anchorX - 3, anchorY - 3, anchorX + 4, anchorY + 4);
        SelectObject(dc, oldBrush);
        SelectObject(dc, oldPen);
        DeleteObject(anchorBrush);
        DeleteObject(pen);
    }
    EndPaint(window, &paint);
}

HRGN CreateLineRegion(POINT from, POINT to)
{
    double dx = static_cast<double>(to.x - from.x);
    double dy = static_cast<double>(to.y - from.y);
    double length = std::max(1.0, std::hypot(dx, dy));
    double nx = -dy * 3.0 / length;
    double ny = dx * 3.0 / length;
    POINT polygon[4]{
        {static_cast<LONG>(std::lround(from.x + nx)), static_cast<LONG>(std::lround(from.y + ny))},
        {static_cast<LONG>(std::lround(to.x + nx)), static_cast<LONG>(std::lround(to.y + ny))},
        {static_cast<LONG>(std::lround(to.x - nx)), static_cast<LONG>(std::lround(to.y - ny))},
        {static_cast<LONG>(std::lround(from.x - nx)), static_cast<LONG>(std::lround(from.y - ny))}
    };
    return CreatePolygonRgn(polygon, ARRAYSIZE(polygon), WINDING);
}

void UpdateHighlightRegion()
{
    if (!highlightWindow) return;
    std::optional<Highlight> current;
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        current = latestHighlight;
    }
    if (!current)
    {
        ShowWindow(highlightWindow, SW_HIDE);
        return;
    }
    RECT client{};
    if (!GetClientRect(highlightWindow, &client)) return;
    int width = client.right - client.left;
    int height = client.bottom - client.top;
    if (width <= 0 || height <= 0) return;
    POINT points[5]{};
    for (size_t index = 0; index < 4; ++index)
    {
        points[index].x = ScaleCoordinate(current->points[index * 2], current->viewportWidth, width);
        points[index].y = ScaleCoordinate(current->points[index * 2 + 1], current->viewportHeight, height);
    }
    points[4] = points[0];
    HRGN region = CreateRectRgn(0, 0, 0, 0);
    for (size_t index = 0; index < 4; ++index)
    {
        HRGN line = CreateLineRegion(points[index], points[index + 1]);
        CombineRgn(region, region, line, RGN_OR);
        DeleteObject(line);
    }
    int anchorX = ScaleCoordinate(current->anchorX, current->viewportWidth, width);
    int anchorY = ScaleCoordinate(current->anchorY, current->viewportHeight, height);
    HRGN anchor = CreateEllipticRgn(anchorX - 5, anchorY - 5, anchorX + 6, anchorY + 6);
    CombineRgn(region, region, anchor, RGN_OR);
    DeleteObject(anchor);
    if (!SetWindowRgn(highlightWindow, region, TRUE))
    {
        DeleteObject(region);
        ShowWindow(highlightWindow, SW_HIDE);
        return;
    }
    ShowWindow(highlightWindow, SW_SHOWNA);
    SetWindowPos(highlightWindow, HWND_TOP, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    InvalidateRect(highlightWindow, nullptr, TRUE);
}

int SignedLowWord(LPARAM value) { return static_cast<short>(LOWORD(value)); }
int SignedHighWord(LPARAM value) { return static_cast<short>(HIWORD(value)); }

void WriteInput(char const* type, int x, int y, int button, int buttons, int delta, int keyCode)
{
    WriteLine(std::string("INPUT|") + type + "|" + std::to_string(x) + "|" + std::to_string(y) + "|"
        + std::to_string(button) + "|" + std::to_string(buttons) + "|" + std::to_string(delta) + "|"
        + std::to_string(keyCode));
}

HWND FindSimulatorEditBox()
{
    if (!IsWindow(simulatorWindow)) return nullptr;
    HWND editBox = FindWindowExW(simulatorWindow, nullptr, L"RICHEDIT50W", nullptr);
    if (!editBox) editBox = FindWindowExW(simulatorWindow, nullptr, L"Edit", nullptr);
    return editBox && IsWindowVisible(editBox) ? editBox : nullptr;
}

bool ForwardSimulatorEditMessage(UINT message, WPARAM wParam, LPARAM lParam)
{
    HWND editBox = FindSimulatorEditBox();
    if (!editBox) return false;
    DWORD currentThread = GetCurrentThreadId();
    DWORD editThread = GetWindowThreadProcessId(editBox, nullptr);
    BOOL attached = editThread != currentThread && AttachThreadInput(currentThread, editThread, TRUE);
    if (editThread == currentThread || attached) SetFocus(editBox);
    BOOL sent = SendNotifyMessageW(editBox, message, wParam, lParam);
    if (attached) AttachThreadInput(currentThread, editThread, FALSE);
    return sent != FALSE;
}

void MapPointer(HWND window, int x, int y, int& mappedX, int& mappedY)
{
    RECT destination{};
    RECT source{};
    if (!GetClientRect(window, &destination) || !GetClientRect(simulatorWindow, &source)) return;
    int destinationWidth = std::max<LONG>(1, destination.right - destination.left);
    int destinationHeight = std::max<LONG>(1, destination.bottom - destination.top);
    int sourceWidth = std::max<LONG>(1, source.right - source.left);
    int sourceHeight = std::max<LONG>(1, source.bottom - source.top);
    mappedX = std::clamp(static_cast<int>(std::lround(static_cast<double>(x) * sourceWidth / destinationWidth)), 0, sourceWidth - 1);
    mappedY = std::clamp(static_cast<int>(std::lround(static_cast<double>(y) * sourceHeight / destinationHeight)), 0, sourceHeight - 1);
}

void ReleasePointerButtons()
{
    int buttons = pointerButtons;
    pointerButtons = 0;
    if (buttons & 1) WriteInput("pointerup", lastPointerX, lastPointerY, 0, 0, 0, 0);
    if (buttons & 4) WriteInput("pointerup", lastPointerX, lastPointerY, 1, 0, 0, 0);
    if (buttons & 2) WriteInput("pointerup", lastPointerX, lastPointerY, 2, 0, 0, 0);
    ReleaseCapture();
}

void ReleaseInputState()
{
    ReleasePointerButtons();
    for (int keyCode : heldKeys) WriteInput("keyup", lastPointerX, lastPointerY, 0, 0, 0, keyCode);
    heldKeys.clear();
}

void HandlePointer(HWND window, char const* type, int button, bool down, LPARAM position)
{
    MapPointer(window, SignedLowWord(position), SignedHighWord(position), lastPointerX, lastPointerY);
    if (button >= 0)
    {
        int mask = button == 0 ? 1 : button == 1 ? 4 : 2;
        if (down)
        {
            pointerButtons |= mask;
            SetFocus(window);
            SetCapture(window);
        }
        else
        {
            pointerButtons &= ~mask;
            if (!pointerButtons) ReleaseCapture();
        }
    }
    WriteInput(type, lastPointerX, lastPointerY, std::max(0, button), pointerButtons, 0, 0);
}

void HandleWheel(HWND window, WPARAM parameter, LPARAM position)
{
    POINT point{SignedLowWord(position), SignedHighWord(position)};
    if (!ScreenToClient(window, &point)) return;
    MapPointer(window, point.x, point.y, lastPointerX, lastPointerY);
    WriteInput("wheel", lastPointerX, lastPointerY, 0, pointerButtons, GET_WHEEL_DELTA_WPARAM(parameter), 0);
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
    case WM_ERASEBKGND:
        return window == highlightWindow ? 1 : DefWindowProcW(window, message, wParam, lParam);
    case WM_PAINT:
        if (window == highlightWindow)
        {
            PaintHighlight(window);
            return 0;
        }
        break;
    case WM_GETDLGCODE:
        return DLGC_WANTALLKEYS;
    case WmAppUpdateBounds:
        return 0;
    case WmAppUpdateHighlight:
        UpdateHighlightRegion();
        return 0;
    case WM_LBUTTONDOWN:
        HandlePointer(window, "pointerdown", 0, true, lParam);
        return 0;
    case WM_LBUTTONUP:
        HandlePointer(window, "pointerup", 0, false, lParam);
        return 0;
    case WM_MBUTTONDOWN:
        HandlePointer(window, "pointerdown", 1, true, lParam);
        return 0;
    case WM_MBUTTONUP:
        HandlePointer(window, "pointerup", 1, false, lParam);
        return 0;
    case WM_RBUTTONDOWN:
        HandlePointer(window, "pointerdown", 2, true, lParam);
        return 0;
    case WM_RBUTTONUP:
        HandlePointer(window, "pointerup", 2, false, lParam);
        return 0;
    case WM_MOUSEMOVE:
        HandlePointer(window, "pointermove", -1, false, lParam);
        return 0;
    case WM_MOUSEWHEEL:
        HandleWheel(window, wParam, lParam);
        return 0;
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
    {
        if (ForwardSimulatorEditMessage(message, wParam, lParam)) return 0;
        int keyCode = static_cast<int>(wParam);
        heldKeys.insert(keyCode);
        WriteInput("keydown", lastPointerX, lastPointerY, 0, pointerButtons, 0, keyCode);
        return 0;
    }
    case WM_KEYUP:
    case WM_SYSKEYUP:
    {
        if (ForwardSimulatorEditMessage(message, wParam, lParam)) return 0;
        int keyCode = static_cast<int>(wParam);
        heldKeys.erase(keyCode);
        WriteInput("keyup", lastPointerX, lastPointerY, 0, pointerButtons, 0, keyCode);
        return 0;
    }
    case WM_CHAR:
    case WM_SYSCHAR:
    case WM_DEADCHAR:
    case WM_SYSDEADCHAR:
    case WM_IME_CHAR:
        if (ForwardSimulatorEditMessage(message, wParam, lParam)) return 0;
        break;
    case WM_UNICHAR:
        if (wParam == UNICODE_NOCHAR) return TRUE;
        if (ForwardSimulatorEditMessage(message, wParam, lParam)) return 0;
        break;
    case WM_KILLFOCUS:
        ReleaseInputState();
        return 0;
    case WM_CAPTURECHANGED:
        if (pointerButtons && reinterpret_cast<HWND>(lParam) != embeddedWindow
            && reinterpret_cast<HWND>(lParam) != highlightWindow)
        {
            ReleasePointerButtons();
        }
        return 0;
    case WM_CLOSE:
        closing = true;
        PostQuitMessage(0);
        return 0;
    case WM_DESTROY:
        if (window == embeddedWindow)
        {
            embeddedWindow = nullptr;
            closing = true;
            PostQuitMessage(0);
        }
        else if (window == highlightWindow)
        {
            highlightWindow = nullptr;
        }
        return 0;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

void UpdateEmbeddedWindows()
{
    if (!IsWindow(parentWindow) || !IsWindow(embeddedWindow) || !IsWindow(highlightWindow))
    {
        throw std::runtime_error("NATIVE_WINDOW_LOST");
    }
    RECT parentClient{};
    CheckWin32(GetClientRect(parentWindow, &parentClient), "GET_PARENT_CLIENT_RECT_FAILED");
    Layout layout;
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        layout = latestLayout;
    }
    double scaleX = static_cast<double>(parentClient.right - parentClient.left) / layout.viewportWidth;
    double scaleY = static_cast<double>(parentClient.bottom - parentClient.top) / layout.viewportHeight;
    int x = static_cast<int>(std::lround(layout.x * scaleX));
    int y = static_cast<int>(std::lround(layout.y * scaleY));
    int width = std::max(1, static_cast<int>(std::lround(layout.width * scaleX)));
    int height = std::max(1, static_cast<int>(std::lround(layout.height * scaleY)));
    CheckWin32(SetWindowPos(embeddedWindow, HWND_TOP, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW),
        "SET_EMBEDDED_WINDOW_POS_FAILED");
    CheckWin32(SetWindowPos(highlightWindow, HWND_TOP, x, y, width, height, SWP_NOACTIVATE),
        "SET_HIGHLIGHT_WINDOW_POS_FAILED");
    UpdateHighlightRegion();
}

void CreateEmbeddedWindows(HINSTANCE instance)
{
    std::wstring className = L"CocosSimulatorCaptureHost_" + std::to_wstring(GetCurrentProcessId());
    WNDCLASSW windowClass{};
    windowClass.lpfnWndProc = WindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    windowClass.lpszClassName = className.c_str();
    if (!RegisterClassW(&windowClass)) ThrowLastError("REGISTER_EMBEDDED_WINDOW_CLASS_FAILED");

    embeddedWindow = CreateWindowExW(0, className.c_str(), L"", WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_TABSTOP,
        0, 0, 32, 32, parentWindow, nullptr, instance, nullptr);
    if (!embeddedWindow) ThrowLastError("CREATE_EMBEDDED_WINDOW_FAILED");
    highlightWindow = CreateWindowExW(0, className.c_str(), L"",
        WS_CHILD | WS_CLIPSIBLINGS | WS_TABSTOP,
        0, 0, 32, 32, parentWindow, nullptr, instance, nullptr);
    if (!highlightWindow) ThrowLastError("CREATE_HIGHLIGHT_WINDOW_FAILED");
    UpdateEmbeddedWindows();
}

direct3d::IDirect3DDevice CreateWinrtDevice()
{
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    D3D_FEATURE_LEVEL selected{};
    HRESULT result = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
        levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, d3dDevice.put(), &selected, d3dContext.put());
    if (FAILED(result))
    {
        check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags,
            levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, d3dDevice.put(), &selected, d3dContext.put()));
    }
    com_ptr<IDXGIDevice> dxgiDevice;
    d3dDevice.as(dxgiDevice);
    com_ptr<IInspectable> inspectable;
    check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put()));
    return inspectable.as<direct3d::IDirect3DDevice>();
}

capture::GraphicsCaptureItem CreateCaptureItem(HWND source)
{
    auto interop = get_activation_factory<capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    capture::GraphicsCaptureItem item{nullptr};
    check_hresult(interop->CreateForWindow(source, guid_of<capture::GraphicsCaptureItem>(), put_abi(item)));
    return item;
}

void CreateSwapChain(UINT width, UINT height)
{
    com_ptr<IDXGIDevice> dxgiDevice;
    d3dDevice.as(dxgiDevice);
    com_ptr<IDXGIAdapter> adapter;
    check_hresult(dxgiDevice->GetAdapter(adapter.put()));
    com_ptr<IDXGIFactory2> factory;
    check_hresult(adapter->GetParent(__uuidof(IDXGIFactory2), factory.put_void()));
    DXGI_SWAP_CHAIN_DESC1 description{};
    description.Width = width;
    description.Height = height;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    description.BufferCount = 2;
    description.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    description.Scaling = DXGI_SCALING_STRETCH;
    description.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    description.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;
    check_hresult(factory->CreateSwapChainForHwnd(d3dDevice.get(), embeddedWindow, &description,
        nullptr, nullptr, swapChain.put()));
    com_ptr<IDXGISwapChain2> swapChain2;
    swapChain.as(swapChain2);
    check_hresult(swapChain2->SetMaximumFrameLatency(1));
    swapChainWidth = width;
    swapChainHeight = height;
}

void ResizeSwapChain(UINT width, UINT height)
{
    if (swapChainWidth == width && swapChainHeight == height) return;
    d3dContext->Flush();
    check_hresult(swapChain->ResizeBuffers(2, width, height, DXGI_FORMAT_B8G8R8A8_UNORM,
        DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT));
    swapChainWidth = width;
    swapChainHeight = height;
}

SourceGeometry ReadSourceGeometry(D3D11_TEXTURE2D_DESC const& texture)
{
    RECT client{};
    CheckWin32(GetClientRect(simulatorWindow, &client), "GET_SIMULATOR_CLIENT_RECT_FAILED");
    UINT clientWidth = static_cast<UINT>(std::max(1L, client.right - client.left));
    UINT clientHeight = static_cast<UINT>(std::max(1L, client.bottom - client.top));
    RECT frame{};
    POINT origin{};
    bool exact = SUCCEEDED(DwmGetWindowAttribute(simulatorWindow, DWMWA_EXTENDED_FRAME_BOUNDS, &frame, sizeof(frame)))
        && ClientToScreen(simulatorWindow, &origin);
    int left = exact ? origin.x - frame.left : static_cast<int>((texture.Width - std::min(texture.Width, clientWidth)) / 2);
    int top = exact ? origin.y - frame.top
        : static_cast<int>(texture.Height - std::min(texture.Height, clientHeight)
            - (texture.Width - std::min(texture.Width, clientWidth)) / 2);
    left = std::clamp(left, 0, static_cast<int>(texture.Width) - 1);
    top = std::clamp(top, 0, static_cast<int>(texture.Height) - 1);
    UINT width = std::min(clientWidth, texture.Width - static_cast<UINT>(left));
    UINT height = std::min(clientHeight, texture.Height - static_cast<UINT>(top));
    if (!width || !height) throw std::runtime_error("INVALID_SIMULATOR_CAPTURE_GEOMETRY");
    return {static_cast<UINT>(left), static_cast<UINT>(top), width, height};
}

void SignalCaptureFailure(std::string const& error)
{
    if (closing.exchange(true)) return;
    {
        std::lock_guard<std::mutex> lock(firstFrameMutex);
        captureFailed = true;
        captureError = error;
    }
    firstFrameCondition.notify_all();
    WriteError(error);
    if (embeddedWindow) PostMessageW(embeddedWindow, WM_CLOSE, 0, 0);
}

void OnFrame(capture::Direct3D11CaptureFramePool const& sender, winrt::Windows::Foundation::IInspectable const&)
{
    try
    {
        std::lock_guard<std::mutex> lock(captureMutex);
        auto frame = sender.TryGetNextFrame();
        if (!frame || !swapChain) return;
        while (auto newerFrame = sender.TryGetNextFrame())
        {
            frame.Close();
            frame = std::move(newerFrame);
        }
        auto surfaceAccess = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        com_ptr<ID3D11Texture2D> source;
        check_hresult(surfaceAccess->GetInterface(__uuidof(ID3D11Texture2D), source.put_void()));
        D3D11_TEXTURE2D_DESC sourceDescription{};
        source->GetDesc(&sourceDescription);
        SourceGeometry geometry = ReadSourceGeometry(sourceDescription);
        ResizeSwapChain(geometry.width, geometry.height);

        com_ptr<ID3D11Texture2D> destination;
        check_hresult(swapChain->GetBuffer(0, __uuidof(ID3D11Texture2D), destination.put_void()));
        D3D11_BOX sourceBox{
            geometry.left,
            geometry.top,
            0,
            geometry.left + geometry.width,
            geometry.top + geometry.height,
            1
        };
        d3dContext->CopySubresourceRegion(destination.get(), 0, 0, 0, 0, source.get(), 0, &sourceBox);
        HRESULT presentResult = swapChain->Present(0, DXGI_PRESENT_DO_NOT_WAIT);
        if (presentResult != DXGI_ERROR_WAS_STILL_DRAWING) check_hresult(presentResult);

        auto contentSize = frame.ContentSize();
        bool recreate = contentSize.Width != captureSize.Width || contentSize.Height != captureSize.Height;
        frame.Close();
        if (recreate)
        {
            captureSize = contentSize;
            sender.Recreate(winrtDevice, directx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, contentSize);
        }
        if (presentResult != DXGI_ERROR_WAS_STILL_DRAWING)
        {
            {
                std::lock_guard<std::mutex> firstLock(firstFrameMutex);
                ++presentedFrames;
            }
            firstFrameCondition.notify_all();
        }
    }
    catch (hresult_error const& error)
    {
        SignalCaptureFailure("CAPTURE_FRAME_FAILED:0x" + [&]() {
            char buffer[16]{};
            sprintf_s(buffer, "%08X", static_cast<unsigned int>(error.code().value));
            return std::string(buffer);
        }());
    }
    catch (std::exception const& error)
    {
        SignalCaptureFailure(std::string("CAPTURE_FRAME_FAILED:") + error.what());
    }
}

void RestoreSimulator();

void PrepareSimulatorForCapture()
{
    CheckWin32(GetWindowRect(simulatorWindow, &originalSimulatorRect), "GET_SIMULATOR_RECT_FAILED");
    RECT client{};
    CheckWin32(GetClientRect(simulatorWindow, &client), "GET_SIMULATOR_CLIENT_RECT_FAILED");
    POINT clientOrigin{};
    CheckWin32(ClientToScreen(simulatorWindow, &clientOrigin), "GET_SIMULATOR_CLIENT_ORIGIN_FAILED");
    originalSimulatorParent = GetWindowLongPtrW(simulatorWindow, GWLP_HWNDPARENT);
    originalSimulatorStyle = GetWindowLongPtrW(simulatorWindow, GWL_STYLE);
    originalSimulatorExStyle = GetWindowLongPtrW(simulatorWindow, GWL_EXSTYLE);
    simulatorPrepared = true;
    try
    {
        LONG_PTR style = originalSimulatorStyle
            & ~(static_cast<LONG_PTR>(WS_CHILD | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU
                | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_CLIPCHILDREN));
        style |= static_cast<LONG_PTR>(WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS);
        SetWindowLongPtrChecked(simulatorWindow, GWL_STYLE, style, "SET_SIMULATOR_STYLE_FAILED");
        CheckWin32(SetWindowPos(simulatorWindow, nullptr, clientOrigin.x, clientOrigin.y,
            std::max(1L, client.right - client.left), std::max(1L, client.bottom - client.top),
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW),
            "PREPARE_SIMULATOR_WINDOW_FAILED");
    }
    catch (...)
    {
        RestoreSimulator();
        throw;
    }
}

void HideSimulatorWindow()
{
    SetWindowLongPtrChecked(simulatorWindow, GWLP_HWNDPARENT,
        reinterpret_cast<LONG_PTR>(parentWindow), "SET_SIMULATOR_OWNER_FAILED");
    LONG_PTR exStyle = originalSimulatorExStyle | static_cast<LONG_PTR>(WS_EX_LAYERED);
    SetWindowLongPtrChecked(simulatorWindow, GWL_EXSTYLE, exStyle, "SET_SIMULATOR_EXSTYLE_FAILED");
    CheckWin32(SetLayeredWindowAttributes(simulatorWindow, 0, 0, LWA_ALPHA), "HIDE_SIMULATOR_WINDOW_FAILED");
    RECT current{};
    CheckWin32(GetWindowRect(simulatorWindow, &current), "GET_SIMULATOR_RECT_FAILED");
    int width = std::max(1L, current.right - current.left);
    int height = std::max(1L, current.bottom - current.top);
    // 移出整个虚拟桌面，避免系统捕获边框覆盖 Workbench，同时不改变 owned window 的 Z 顺序。
    int x = GetSystemMetrics(SM_XVIRTUALSCREEN) - width - 16;
    int y = GetSystemMetrics(SM_YVIRTUALSCREEN) - height - 16;
    CheckWin32(SetWindowPos(simulatorWindow, nullptr, x, y, width, height,
        SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW), "PARK_SIMULATOR_WINDOW_FAILED");
}

void RestoreSimulator()
{
    if (!simulatorPrepared || !IsWindow(simulatorWindow)) return;
    simulatorPrepared = false;
    SetWindowLongPtrW(simulatorWindow, GWL_STYLE, originalSimulatorStyle);
    SetWindowLongPtrW(simulatorWindow, GWL_EXSTYLE, originalSimulatorExStyle);
    SetWindowLongPtrW(simulatorWindow, GWLP_HWNDPARENT, originalSimulatorParent);
    int width = std::max(1L, originalSimulatorRect.right - originalSimulatorRect.left);
    int height = std::max(1L, originalSimulatorRect.bottom - originalSimulatorRect.top);
    SetWindowPos(simulatorWindow, nullptr, originalSimulatorRect.left, originalSimulatorRect.top, width, height,
        SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS);
}

void StartCapture()
{
    if (!capture::GraphicsCaptureSession::IsSupported()) throw std::runtime_error("WINDOWS_GRAPHICS_CAPTURE_UNAVAILABLE");
    PrepareSimulatorForCapture();
    captureItem = CreateCaptureItem(simulatorWindow);
    captureSize = captureItem.Size();
    winrtDevice = CreateWinrtDevice();
    RECT client{};
    CheckWin32(GetClientRect(simulatorWindow, &client), "GET_SIMULATOR_CLIENT_RECT_FAILED");
    CreateSwapChain(static_cast<UINT>(std::max(1L, client.right - client.left)),
        static_cast<UINT>(std::max(1L, client.bottom - client.top)));
    framePool = capture::Direct3D11CaptureFramePool::CreateFreeThreaded(winrtDevice,
        directx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, captureSize);
    frameToken = framePool.FrameArrived(OnFrame);
    closedToken = captureItem.Closed([](capture::GraphicsCaptureItem const&, winrt::Windows::Foundation::IInspectable const&) {
        SignalCaptureFailure("SIMULATOR_CAPTURE_CLOSED");
    });
    captureSession = framePool.CreateCaptureSession(captureItem);
    captureSession.IsCursorCaptureEnabled(false);
    captureSession.StartCapture();

    std::unique_lock<std::mutex> lock(firstFrameMutex);
    if (!firstFrameCondition.wait_for(lock, 5s, [] { return presentedFrames >= 2 || captureFailed; }))
    {
        throw std::runtime_error("SIMULATOR_CAPTURE_FIRST_FRAME_TIMEOUT");
    }
    if (captureFailed) throw std::runtime_error(captureError);
    lock.unlock();
    HideSimulatorWindow();
    lock.lock();
    std::uint64_t hiddenTarget = presentedFrames + 1;
    if (!firstFrameCondition.wait_for(lock, 2s, [hiddenTarget] { return presentedFrames >= hiddenTarget || captureFailed; }))
    {
        throw std::runtime_error("SIMULATOR_CAPTURE_HIDDEN_FRAME_TIMEOUT");
    }
    if (captureFailed) throw std::runtime_error(captureError);
}

void CALLBACK HandleWindowDestroyed(HWINEVENTHOOK, DWORD eventType, HWND window, LONG, LONG, DWORD, DWORD)
{
    if (eventType == EVENT_OBJECT_DESTROY && (window == parentWindow || window == simulatorWindow))
    {
        if (embeddedWindow) PostMessageW(embeddedWindow, WM_CLOSE, 0, 0);
    }
}

void StartLifetimeWatch()
{
    destroyHook = SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY, nullptr,
        HandleWindowDestroyed, 0, 0, WindowEventFlags);
    if (!destroyHook) ThrowLastError("SET_DESTROY_EVENT_HOOK_FAILED");
}

void StartCommandReader()
{
    std::thread([] {
        try
        {
            std::string line;
            while (std::getline(std::cin, line))
            {
                if (line == "DETACH" || line == "EXIT") break;
                if (line.rfind("BOUNDS|", 0) == 0)
                {
                    auto values = Split(line, '|');
                    if (values.size() != 7) throw std::runtime_error("INVALID_BOUNDS_COMMAND");
                    {
                        std::lock_guard<std::mutex> lock(stateMutex);
                        latestLayout = ParseLayout(values, 1);
                    }
                    if (embeddedWindow) PostMessageW(embeddedWindow, WmAppUpdateBounds, 0, 0);
                    continue;
                }
                if (line == "HIGHLIGHT|CLEAR")
                {
                    {
                        std::lock_guard<std::mutex> lock(stateMutex);
                        latestHighlight.reset();
                    }
                    if (highlightWindow) PostMessageW(highlightWindow, WmAppUpdateHighlight, 0, 0);
                    continue;
                }
                if (line.rfind("HIGHLIGHT|", 0) == 0)
                {
                    auto values = Split(line, '|');
                    {
                        std::lock_guard<std::mutex> lock(stateMutex);
                        latestHighlight = ParseHighlight(values);
                    }
                    if (highlightWindow) PostMessageW(highlightWindow, WmAppUpdateHighlight, 0, 0);
                }
            }
        }
        catch (std::exception const& error)
        {
            WriteError(error.what());
        }
        if (embeddedWindow) PostMessageW(embeddedWindow, WM_CLOSE, 0, 0);
    }).detach();
}

void CleanupCapture()
{
    std::lock_guard<std::mutex> lock(captureMutex);
    if (framePool)
    {
        framePool.FrameArrived(frameToken);
    }
    if (captureItem)
    {
        captureItem.Closed(closedToken);
    }
    captureSession = nullptr;
    framePool = nullptr;
    captureItem = nullptr;
    swapChain = nullptr;
    d3dContext = nullptr;
    d3dDevice = nullptr;
    winrtDevice = nullptr;
}

void Cleanup()
{
    closing = true;
    ReleaseInputState();
    if (destroyHook)
    {
        UnhookWinEvent(destroyHook);
        destroyHook = nullptr;
    }
    CleanupCapture();
    if (highlightWindow && IsWindow(highlightWindow)) DestroyWindow(highlightWindow);
    if (embeddedWindow && IsWindow(embeddedWindow)) DestroyWindow(embeddedWindow);
    highlightWindow = nullptr;
    embeddedWindow = nullptr;
    RestoreSimulator();
}

void Run(int argc, wchar_t** argv)
{
    if (argc != 10) throw std::runtime_error("EXPECTED_9_ARGUMENTS");
    SetProcessDpiAwarenessContext(reinterpret_cast<DPI_AWARENESS_CONTEXT>(-4));
    parentProcessId = ParseProcessId(argv[1], false);
    DWORD requestedSimulatorProcessId = ParseProcessId(argv[2], true);
    auto parentTitles = SplitTitles(argv[3]);
    if (parentTitles.empty()) throw std::runtime_error("WORKBENCH_WINDOW_TITLE_REQUIRED");
    latestLayout = ParseLayout(argv, 4);
    parentWindow = WaitForWindow(parentProcessId, parentTitles, 10s);
    simulatorWindow = WaitForSimulatorWindow(requestedSimulatorProcessId, parentProcessId, 10s);
    CreateEmbeddedWindows(GetModuleHandleW(nullptr));
    StartCapture();
    StartLifetimeWatch();
    StartCommandReader();
    WriteLine("READY|" + std::to_string(reinterpret_cast<intptr_t>(parentWindow)) + "|"
        + std::to_string(reinterpret_cast<intptr_t>(simulatorWindow)) + "|" + std::to_string(simulatorProcessId)
        + "|" + std::to_string(reinterpret_cast<intptr_t>(embeddedWindow)));

    MSG message{};
    while (true)
    {
        int result = GetMessageW(&message, nullptr, 0, 0);
        if (result == 0) break;
        if (result < 0) ThrowLastError("GET_MESSAGE_FAILED");
        if (message.message == WmAppUpdateBounds)
        {
            UpdateEmbeddedWindows();
            continue;
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}
}

int wmain(int argc, wchar_t** argv)
{
    int exitCode = 0;
    try
    {
        init_apartment(apartment_type::multi_threaded);
        Run(argc, argv);
    }
    catch (hresult_error const& error)
    {
        char code[16]{};
        sprintf_s(code, "%08X", static_cast<unsigned int>(error.code().value));
        WriteError(std::string("HRESULT_0x") + code + ":" + WideToUtf8(error.message().c_str()));
        exitCode = 1;
    }
    catch (std::exception const& error)
    {
        WriteError(error.what());
        exitCode = 1;
    }
    Cleanup();
    return exitCode;
}
