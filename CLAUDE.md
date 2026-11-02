# Muse Manager — hướng dẫn cho Claude

Tool chạy trên máy người dùng (Windows). Nó dùng nhiều tài khoản **muse.ai** (trợ lý chat của Meta) để tạo ảnh và video cho **kênh YouTube về lịch sử Việt Nam** của người dùng. Tool có hàng đợi, chia việc cho các tài khoản, nối clip cho đủ thời lượng, phóng lên 1080p rồi lưu file về `downloads/`.

Người dùng nói tiếng Việt: trả lời bằng tiếng Việt.

## Quy tắc bắt buộc

- **Không bao giờ đăng nhập hay nhập mật khẩu thay người dùng.** Khi tài khoản ở trạng thái "Cần đăng nhập", chạy `npm run muse -- accounts add <tên>`, hoặc nhờ người dùng bấm **Mở cửa sổ** trong tab Tài khoản. Người dùng tự đăng nhập trong cửa sổ Chrome đó, sau đó chạy `npm run muse -- accounts verify <tên>`.
- **Mỗi lần tạo tốn lượt thật**: 1 ảnh tốn 1 lượt; 1 video dài D giây tốn `ceil(D/10)` clip. Hỏi người dùng trước khi đẩy một loạt lớn (khoảng hơn 10 lượt), hoặc khi chưa rõ họ muốn tạo gì.
- Không sửa tay `data/*.json` khi tool đang chạy. Không đụng `profiles/`: thư mục này chứa phiên đăng nhập, không được commit hay chia sẻ.
- Tool gửi tin nhắn vào **Main chat** của từng tài khoản muse.ai.

## Bật tool và dùng lệnh

Mọi lệnh gọi API của tool đang chạy (`http://127.0.0.1:3000`). Luôn bật tool trước:

```bash
npm run muse -- start
```

Lệnh `start` chạy tool ngầm, không mở trình duyệt; nếu tool đã chạy sẵn thì không làm gì. Việc tạo ảnh/video chạy trong Chrome ẩn; cửa sổ Chrome chỉ hiện khi cần đăng nhập. Giao diện cho người dùng: http://localhost:3000.

| Lệnh | Việc |
|---|---|
| `npm run muse -- status --json` | Tài khoản (trạng thái, số việc hôm nay) và số việc trong hàng đợi |
| `npm run muse -- add --prompt "..." [--type image\|video] [--duration 1-60] [--ref ảnh.png]... [--count n] [--no-1080p] --wait --json` | Thêm một việc; có `--wait` thì chờ xong và in đường dẫn file |
| `npm run muse -- batch scenes.json --wait --json` | Thêm cả loạt cảnh (xem mẫu bên dưới) |
| `npm run muse -- wait <jobId...> --json` | Chờ các việc đã thêm |
| `npm run muse -- retry <jobId...>` | Chạy lại việc bị lỗi, bị từ chối hoặc đã hủy |
| `npm run muse -- jobs --limit 20 --json` | Các việc gần đây |
| `npm run muse -- accounts` / `accounts add <tên>` / `accounts verify <id\|tên>` | Quản lý tài khoản |

Mã thoát: `0` ổn · `1` có việc lỗi, bị từ chối, hoặc dữ liệu sai · `2` tool chưa chạy (hãy chạy `start`) · `3` hết thời gian chờ (việc vẫn đang chạy trong tool, dùng `wait` để chờ tiếp).

Mặc định `video`, 10 giây, bật 1080p. Một lần `--wait` có thể mất vài phút: mỗi clip mất khoảng 1–2 phút, cộng thêm thời gian nghỉ 20–60 giây giữa hai việc trên cùng một tài khoản. Với loạt lớn, nên chạy lệnh ở chế độ nền.

## Quy trình gợi ý cho kênh lịch sử

1. Viết kịch bản, rồi chia thành các cảnh dài 5–15 giây.
2. Viết prompt cho từng cảnh bằng tiếng Việt, và **kết thúc mọi prompt bằng cùng một câu phong cách** để các cảnh đồng bộ, ví dụ: `phong cách phim tài liệu lịch sử điện ảnh, ánh sáng tự nhiên, ảnh chân thực`.
3. **Tạo ảnh chủ đạo cho từng cảnh trước** (`--type image`), rồi để người dùng xem và chọn.
4. **Tạo video bằng cách lấy ảnh đó làm `--ref`.** Hình trong video sẽ bám theo ảnh. Cách này đã thử thật: ảnh 1920×1280 cho ra video 1620×1080.

Mẫu `scenes.json`. Đường dẫn trong `refs` tính từ thư mục chứa file:

```json
[
  { "prompt": "Bãi cọc gỗ trên sông Bạch Đằng lúc thủy triều rút, sương sớm, phong cách phim tài liệu lịch sử điện ảnh", "type": "image" },
  { "prompt": "Thuyền chiến Nguyên Mông mắc cạn giữa bãi cọc khi nước rút, quân Đại Việt phóng hỏa, phong cách phim tài liệu lịch sử điện ảnh", "duration": 15, "refs": ["refs/bai-coc.webp"] }
]
```

File kết quả nằm ở `downloads/YYYY-MM-DD/<jobId>_<slug>.mp4` (ảnh là `.webp`). Kết quả JSON của `--wait` có sẵn đường dẫn đầy đủ trong `outputs`.

## Giới hạn thật của muse.ai (đo trực tiếp ngày 2026-11-02)

- Clip luôn dài **10 giây**. Độ phân giải theo tỉ lệ ảnh tham chiếu: ảnh 3:2 cho ra 1152×768; không có ảnh tham chiếu thì khoảng 1280×720.
- "1080p" là tool **phóng to** video, không phải video gốc 1080p.
- Video dài hơn 10 giây là nhiều clip nối lại, mỗi clip sau lấy khung hình cuối của clip trước làm tham chiếu. Ở mỗi mốc 10 giây có **một lần chuyển cảnh**, không liền mạch tuyệt đối. Nên viết kịch bản sao cho mỗi cảnh không quá 10–15 giây.
- Muse đôi khi hỏi lại thay vì tạo ngay. Tool coi đó là lỗi tạm thời và tự thử lại tối đa 2 lần.

## Khi gặp lỗi

- **Tài khoản "Hết lượt"**: tool tự cho tài khoản nghỉ 24 giờ và chuyển việc sang tài khoản khác. Nếu mọi tài khoản đều hết lượt, `status` sẽ cảnh báo, và việc chỉ chạy tiếp khi có tài khoản hết thời gian nghỉ.
- **Tài khoản "Cần đăng nhập"**: báo người dùng tự đăng nhập lại (xem phần Quy tắc bắt buộc).
- **Việc "Lỗi"**: xem trường `error` và `replyText` trong `jobs --json`, xem ảnh chụp màn hình trong `data/errors/<jobId>-*.png`, rồi chạy `retry` nếu hợp lý.
- **Việc "Bị từ chối"**: Muse không tạo nội dung đó. Viết lại prompt nhẹ nhàng hơn rồi thêm thành một việc mới.

## Phát triển và sửa tool

- `npm test`: khoảng 130 test, dùng Chrome ẩn với một trang "muse.ai giả" và ffmpeg thật, nên **không tốn lượt**. Chạy mất khoảng 2 phút.
- Mọi chỗ bám vào HTML của muse.ai nằm trong `src/muse/selectors.js`. Ba điều học được khi chạy thật, phải giữ nguyên trong `src/muse/driver.js`:
  1. Chat dài mở ra ở chỗ đọc dở, nên phải cuộn xuống cuối mới thấy câu trả lời mới.
  2. Nút Send bị khóa trong lúc ảnh đính kèm đang tải lên; gửi lúc đó muse.ai sẽ báo "Delivery not confirmed".
  3. Ảnh/video mất vài giây mới giải mã xong, nên phải chờ trước khi kết luận "không có media". Kết luận sai sẽ làm tốn thêm lượt.
- Thiết kế và kế hoạch: `docs/superpowers/specs/`, `docs/superpowers/plans/`.
- Muốn thử trên muse.ai thật thì phải hỏi người dùng trước, vì mỗi lần thử tốn lượt.
