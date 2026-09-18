from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


OUTPUT = Path("output/pdf/synthetic-bookkeeping-invoice.pdf")


def create_invoice() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    page_width, page_height = A4
    pdf = canvas.Canvas(
        str(OUTPUT),
        pagesize=A4,
        pageCompression=0,
        invariant=1,
    )
    pdf.setTitle("Synthetic Bookkeeping Invoice BK-2026-001")
    pdf.setAuthor("Invoice-to-Ledger Agent")
    pdf.setSubject("Synthetic invoice fixture - not a real bill")

    navy = HexColor("#17324D")
    blue = HexColor("#2374AB")
    pale = HexColor("#EAF3F8")
    gray = HexColor("#5D6875")
    line = HexColor("#CAD3DD")

    pdf.setFillColor(navy)
    pdf.rect(0, page_height - 128, page_width, 128, fill=1, stroke=0)
    pdf.setFillColor(HexColor("#FFFFFF"))
    pdf.setFont("Helvetica-Bold", 23)
    pdf.drawString(48, page_height - 58, "NORTHSTAR DEMO SUPPLIES")
    pdf.setFont("Helvetica", 10)
    pdf.drawString(48, page_height - 80, "Synthetic vendor for controlled testing only")
    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawRightString(page_width - 48, page_height - 58, "INVOICE")
    pdf.setFillColor(HexColor("#FFD166"))
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawRightString(page_width - 48, page_height - 82, "SYNTHETIC - NOT A REAL BILL")

    top = page_height - 166
    pdf.setFillColor(navy)
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(48, top, "INVOICE DETAILS")
    pdf.setFillColor(gray)
    pdf.setFont("Helvetica", 10)
    details = [
        ("Invoice number:", "BK-2026-001"),
        ("Invoice date:", "2026-09-08"),
        ("Currency:", "USD"),
        ("Pricing:", "net"),
    ]
    for index, (label, value) in enumerate(details):
        y = top - 22 - index * 18
        pdf.drawString(48, y, label)
        pdf.setFillColor(navy)
        pdf.setFont("Helvetica-Bold", 10)
        pdf.drawString(132, y, value)
        pdf.setFillColor(gray)
        pdf.setFont("Helvetica", 10)

    pdf.setFillColor(navy)
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(330, top, "BILL TO")
    pdf.setFillColor(gray)
    pdf.setFont("Helvetica", 10)
    pdf.drawString(330, top - 22, "Example Customer (synthetic)")
    pdf.drawString(330, top - 40, "No payment is due")

    table_top = top - 116
    widths = [275, 65, 90, 90]
    x_positions = [48]
    for width in widths:
        x_positions.append(x_positions[-1] + width)
    pdf.setFillColor(pale)
    pdf.rect(48, table_top - 26, sum(widths), 26, fill=1, stroke=0)
    pdf.setFillColor(navy)
    pdf.setFont("Helvetica-Bold", 9)
    headers = ["DESCRIPTION", "QTY", "UNIT PRICE", "LINE NET"]
    for index, header in enumerate(headers):
        x = x_positions[index] + (8 if index == 0 else widths[index] - 8)
        if index == 0:
            pdf.drawString(x, table_top - 17, header)
        else:
            pdf.drawRightString(x, table_top - 17, header)

    rows = [
        ("Bookkeeping workflow design", "2", "50.00", "100.00"),
        ("Secure result hosting review", "1", "25.00", "25.00"),
    ]
    pdf.setFont("Helvetica", 10)
    for row_index, row in enumerate(rows):
        y_top = table_top - 26 - row_index * 38
        pdf.setStrokeColor(line)
        pdf.line(48, y_top - 38, 48 + sum(widths), y_top - 38)
        pdf.setFillColor(navy)
        pdf.drawString(x_positions[0] + 8, y_top - 23, row[0])
        for column in range(1, 4):
            pdf.drawRightString(x_positions[column] + widths[column] - 8, y_top - 23, row[column])

    totals_top = table_top - 122
    pdf.setFillColor(gray)
    pdf.setFont("Helvetica", 10)
    pdf.drawRightString(470, totals_top, "Subtotal")
    pdf.setFillColor(navy)
    pdf.drawRightString(568, totals_top, "125.00")
    pdf.setFillColor(gray)
    pdf.drawRightString(470, totals_top - 22, "Tax (demo value; no jurisdiction implied)")
    pdf.setFillColor(navy)
    pdf.drawRightString(568, totals_top - 22, "25.00")
    pdf.setStrokeColor(blue)
    pdf.setLineWidth(1.5)
    pdf.line(400, totals_top - 34, 568, totals_top - 34)
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawRightString(470, totals_top - 56, "Total")
    pdf.drawRightString(568, totals_top - 56, "150.00")

    note_top = totals_top - 118
    pdf.setFillColor(pale)
    pdf.roundRect(48, note_top - 76, 520, 76, 6, fill=1, stroke=0)
    pdf.setFillColor(navy)
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(62, note_top - 21, "TEST NOTICE")
    pdf.setFont("Helvetica", 9)
    pdf.drawString(62, note_top - 40, "This document is synthetic. It has no legal, tax, payment, or accounting effect.")
    pdf.drawString(62, note_top - 56, "Expected use: send as an attachment to the authorized Telnyx test inbox.")

    pdf.setFillColor(gray)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(48, 42, "Fixture ID: SYNTHETIC-BK-2026-001")
    pdf.drawRightString(page_width - 48, 42, "Page 1 of 1")
    pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    create_invoice()
