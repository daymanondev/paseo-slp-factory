# andrew-room — SLP riêng của Andrew

Repo này là nơi build **`paseo-factory`** — plugin Paseo riêng triển khai room SLP
(Supervisor–Lead–Peer) theo stack của Andrew: **GLM viết · Gemini/Agy chấm và nhìn · Jev canh ·
Human quyết**. Kiến trúc core-first: core thuần Node (contracts, ledger, gate) + vỏ plugin
server-only, UI đắp sau khi contract chín. Trong lúc dựng, room chạy production trên seatworks
v3 (data-only, không fork) làm hệ đối chiếu. Doc phát triển sống:
[research/03-hands-on/04-andrew-room.md](research/03-hands-on/04-andrew-room.md) — model map,
prompts, runbook, lịch sử quyết định.

**Trạng thái: đang khởi động** (30/9/2026) — phần lớn tri thức nền đã nghiên cứu xong, bắt
đầu đưa vào vận hành thật cho dự án thật.

## Cấu trúc repo

| Vị trí | Là gì |
|---|---|
| `research/` | **Kho tư liệu nội bộ, không theo git** (đã `.gitignore`) — toàn bộ giai đoạn nghiên cứu Paseo/SLP. Index: [research/README.md](research/README.md) |
| `paseo-factory/` *(sắp có)* | Plugin: core (contracts + ledger JSONL + gate runner + report) + vỏ plugin server-only |

## Nguyên tắc mang theo từ giai đoạn nghiên cứu

- Bất biến duy nhất: **ai viết thì không phải người accept** (separation of judgment).
- Cưỡng chế bằng **cơ chế** (provider, môi trường, gate) — không bằng lời dặn.
- Model theo vai: mắt phán xét tốn token, tay chân thì không.

---

*Chi tiết hơn khi dự án thành hình — README này sẽ lớn dần cùng code.*
