# andrew-room — SLP riêng của Andrew

Repo này là nơi **build một room SLP (Supervisor–Lead–Peer) cho riêng mình**, vận hành trên
Paseo + seatworks v3 (data-only, không fork). Doc phát triển sống:
[research/03-hands-on/04-andrew-room.md](research/03-hands-on/04-andrew-room.md) — model map,
prompts, runbook.

**Trạng thái: đang khởi động** (30/9/2026) — phần lớn tri thức nền đã nghiên cứu xong, bắt
đầu đưa vào vận hành thật cho dự án thật.

## Cấu trúc repo

| Vị trí | Là gì |
|---|---|
| `research/` | **Kho tư liệu nội bộ, không theo git** (đã `.gitignore`) — toàn bộ giai đoạn nghiên cứu Paseo/SLP. Index: [research/README.md](research/README.md) |
| *(sắp có)* | Code + cấu hình của room: roles, prompts, scripts vận hành |

## Nguyên tắc mang theo từ giai đoạn nghiên cứu

- Bất biến duy nhất: **ai viết thì không phải người accept** (separation of judgment).
- Cưỡng chế bằng **cơ chế** (provider, môi trường, gate) — không bằng lời dặn.
- Model theo vai: mắt phán xét tốn token, tay chân thì không.

---

*Chi tiết hơn khi dự án thành hình — README này sẽ lớn dần cùng code.*
