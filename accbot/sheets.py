"""Mirror approved deals to a Google Sheet (optional: skipped when not configured)."""

import asyncio
import logging
import os

import gspread

from .parser import asset_name
from .storage import Deal

log = logging.getLogger(__name__)

HEADER = [
    "شناسه", "تاریخ (شمسی)", "تاریخ (میلادی)", "مشتری", "نوع", "مقدار", "ارز",
    "قیمت واحد (تومان)", "مبلغ کل (تومان)", "توضیحات", "ثبت‌کننده", "تاییدکننده",
    "زمان تایید", "وضعیت", "لینک پیام",
]
STATUS_COL = HEADER.index("وضعیت") + 1
SIDE_FA = {"BUY": "خرید", "SELL": "فروش", "PAY": "پرداخت (ما → مشتری)", "RECEIVE": "دریافت (مشتری → ما)"}


class Sheet:
    def __init__(self, credentials_file: str, sheet_id: str, worksheet: str):
        self._credentials_file = credentials_file
        self._sheet_id = sheet_id
        self._worksheet_name = worksheet
        self._ws: gspread.Worksheet | None = None

    @property
    def enabled(self) -> bool:
        return bool(self._sheet_id) and os.path.isfile(self._credentials_file)

    def _worksheet(self) -> gspread.Worksheet:
        if self._ws is None:
            gc = gspread.service_account(filename=self._credentials_file)
            sh = gc.open_by_key(self._sheet_id)
            try:
                ws = sh.worksheet(self._worksheet_name)
            except gspread.WorksheetNotFound:
                ws = sh.add_worksheet(self._worksheet_name, rows=1000, cols=len(HEADER))
            if not ws.row_values(1):
                ws.append_row(HEADER)
                ws.format("1:1", {"textFormat": {"bold": True}})
                ws.freeze(rows=1)
                sh.batch_update({"requests": [{"updateSheetProperties": {
                    "properties": {"sheetId": ws.id, "rightToLeft": True}, "fields": "rightToLeft",
                }}]})
            self._ws = ws
        return self._ws

    def _append(self, deal: Deal, jalali: str, approved_at: str, link: str) -> None:
        t = deal.trade
        row = [
            deal.code, jalali, deal.created_at[:16].replace("T", " "), deal.client, SIDE_FA[t.side],
            float(t.amount), asset_name(t.asset),
            float(t.rate) if t.rate is not None else "",
            float(t.total) if t.total is not None else "",
            t.note, deal.created_by, deal.decided_by or "", approved_at, "تایید شده", link,
        ]
        self._worksheet().append_row(row, value_input_option="USER_ENTERED")

    def _set_status(self, deal: Deal, status: str) -> None:
        ws = self._worksheet()
        cell = ws.find(deal.code, in_column=1)
        if cell is None:
            log.warning("%s not found in sheet; status not updated", deal.code)
            return
        ws.update_cell(cell.row, STATUS_COL, status)

    async def append(self, deal: Deal, jalali: str, approved_at: str, link: str) -> None:
        await asyncio.to_thread(self._append, deal, jalali, approved_at, link)

    async def set_status(self, deal: Deal, status: str) -> None:
        await asyncio.to_thread(self._set_status, deal, status)
