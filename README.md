# Triển khai VănMạch Web lên Render.com (miễn phí 24/7)

Thư mục này chỉ chứa mã nguồn sạch để đẩy lên GitHub và Render.com (không chứa `.env`, `.data`, SQLite, khóa mã hóa hoặc API key).

## Các bước đưa web lên mạng

1. **Đẩy thư mục này lên một repo GitHub mới (Public hoặc Private đều được):**
   ```powershell
   cd C:\VSCodeKHKT\VanMach\10_DEPLOYMENT\render
   git remote add origin https://github.com/<TEN_GITHUB>/<TEN_REPO>.git
   git push -u origin main
   ```

2. **Tạo dịch vụ trên Render (Blueprint Docker miễn phí):**
   - Đăng nhập [https://dashboard.render.com](https://dashboard.render.com).
   - Chọn **New +** -> **Blueprint**, kết nối repo GitHub vừa đẩy -> **Apply**.
   - Render sẽ đọc tệp `render.yaml` (`plan: free`, Docker).
   - Khi được hỏi biến môi trường **`GEMINI_API_KEY`**, dán API key Gemini của bạn vào (nhập trực tiếp trên Render, không lưu trong Git).
   - Đợi vài phút để Render build Docker và báo **Live** (ví dụ `https://vanmach-web.onrender.com`).

3. **Bật đăng nhập Google trên Firebase:**
   - Mở Firebase Console của dự án `vanmach-8b20f` -> **Authentication** -> **Settings** -> **Authorized domains**.
   - Bấm **Add domain**, dán tên miền Render của bạn (ví dụ `vanmach-web.onrender.com`, không có `https://`).

4. **Lưu ý với gói Render Free:**
   - Nếu khoảng 15 phút không có người truy cập, Render sẽ tạm ngủ và tự bật lại khi có người mở link (lần mở lại đầu tiên mất khoảng 30-50 giây).
   - Gói Free dùng ổ cứng tạm thời: dữ liệu phòng học đang tạo và tài khoản tạo bằng email/mật khẩu trên máy chủ có thể đặt lại khi Render khởi động lại container; tài khoản Google Firebase vẫn đăng nhập lại bình thường.