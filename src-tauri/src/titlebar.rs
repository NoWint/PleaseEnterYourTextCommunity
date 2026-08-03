// 无边框窗口(Win/Linux)标题栏的系统集成。
//
// Windows:decorations:false 时系统不绘制标题栏,原生 Win11 snap layout 分组弹窗
// 也不会出现。方案:子类化窗口过程,在 WM_NCHITTEST 里对「最大化/还原」按钮区域
// 返回 HTMAXBUTTON —— 系统据此在鼠标悬停时显示 snap layout flyout,
// 点击时由系统处理最大化/还原(与原生标题栏一致)。
//
// 只拦截最大化按钮区域,其余调用原窗口过程(wry 的),保留拖拽/resize 边缘/最小化
// 关闭按钮的前端处理。data-tauri-drag-region 拖拽经前端 startDragging() 走
// WM_NCLBUTTONDOWN+HTCAPTION,与本子类化互不影响。

use std::sync::atomic::{AtomicUsize, Ordering};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, GWLP_WNDPROC, GetClientRect, GetMessagePos, HTMAXBUTTON, SetWindowLongPtrW,
    WM_NCHITTEST, WNDPROC,
};

/// 保存被替换的原始窗口过程(wry 的),链式调用保留其 hit-test 逻辑。
static OLD_WNDPROC: AtomicUsize = AtomicUsize::new(0);

// 前端标题栏几何(逻辑 px),须与 styles.css 的 .wb-btn/.wb-controls 一致。
const TITLEBAR_H: f32 = 34.0;
const BTN_W: f32 = 46.0;

unsafe extern "system" fn custom_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCHITTEST {
        // GetMessagePos 返回屏幕坐标(高位 y / 低位 x,带符号)→ 客户区坐标。
        let pos = GetMessagePos();
        let l = pos as i32;
        let mut pt = POINT {
            x: (l & 0xffff) as i16 as i32,
            y: ((l >> 16) & 0xffff) as i16 as i32,
        };
        if ScreenToClient(hwnd, &mut pt).as_bool() {
            let mut rect = RECT::default();
            if GetClientRect(hwnd, &mut rect).is_ok() {
                // 物理像素换算:GetClientRect 是物理 px,CSS 是逻辑 px。
                let dpi = GetDpiForWindow(hwnd);
                let scale = dpi as f32 / 96.0;
                let btn_w = (BTN_W * scale) as i32;
                let title_h = (TITLEBAR_H * scale) as i32;
                let right = rect.right;
                // 右侧三按钮:close(最右,占用 [right-w, right])、max(中,占用
                // [right-2w, right-w])、min(左)。只拦截 max 区域。
                if pt.y >= 0
                    && pt.y < title_h
                    && pt.x >= right - 2 * btn_w
                    && pt.x < right - btn_w
                {
                    return LRESULT(HTMAXBUTTON as isize);
                }
            }
        }
    }

    let old = OLD_WNDPROC.load(Ordering::SeqCst);
    if old == 0 {
        LRESULT(0)
    } else {
        let prev: WNDPROC = std::mem::transmute(old);
        CallWindowProcW(prev, hwnd, msg, wparam, lparam)
    }
}

/// 子类化窗口过程:安装 custom_wndproc,保存原过程。
/// 需在窗口创建后调用一次;窗口销毁后不再访问 OLD_WNDPROC。
pub fn install(hwnd: HWND) -> Result<(), windows::core::Error> {
    unsafe {
        // SetWindowLongPtrW 返回前一个窗口过程;0 表示失败(正常窗口过程非 0)。
        // 函数指针 → 整数,规范做法是先转 *const () 再转 isize(避免 function_casts_as_integer)。
        let old = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, custom_wndproc as *const () as isize);
        if old == 0 {
            Err(windows::core::Error::from_win32())
        } else {
            OLD_WNDPROC.store(old as usize, Ordering::SeqCst);
            Ok(())
        }
    }
}
