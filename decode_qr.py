#!/usr/bin/env python3
"""Decode a barcode (QR, Aztec, etc.) from a boarding pass image and parse IATA BCBP data."""

import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Missing dependency: pip install Pillow")

try:
    import zxingcpp
except ImportError:
    sys.exit("Missing dependency: pip install zxing-cpp")


def parse_bcbp(raw: str) -> dict:
    """Parse IATA Bar Coded Boarding Pass (BCBP) format string."""
    if len(raw) < 23:
        return {"raw": raw}

    result = {
        "format_code": raw[0],
        "number_of_legs": raw[1],
        "passenger_name": raw[2:22].strip(),
        "electronic_ticket_indicator": raw[22],
    }

    # First leg (mandatory fields)
    if len(raw) >= 37:
        result["pnr"] = raw[23:30].strip()
        result["origin"] = raw[30:33]
        result["destination"] = raw[33:36]
        result["operating_carrier"] = raw[36:39].strip()
        if len(raw) >= 44:
            result["flight_number"] = raw[39:44].strip()
        if len(raw) >= 47:
            result["date_of_flight"] = raw[44:47].strip()
        if len(raw) >= 48:
            result["compartment_code"] = raw[47]
        if len(raw) >= 52:
            result["seat_number"] = raw[48:52].strip()
        if len(raw) >= 57:
            result["check_in_sequence"] = raw[52:57].strip()
        if len(raw) >= 58:
            result["passenger_status"] = raw[57]

    return result


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <image_path>")
        sys.exit(1)

    image_path = sys.argv[1]
    img = Image.open(image_path)
    results = zxingcpp.read_barcodes(img)

    if not results:
        print("No barcode found in the image.")
        sys.exit(1)

    for i, result in enumerate(results):
        raw_data = result.text
        print(f"--- Barcode {i + 1} ---")
        print(f"Format: {result.format}")
        print(f"Raw data: {raw_data}")
        print()

        # Try to parse as BCBP
        if raw_data and raw_data[0] in ("M", "S"):
            print("Parsed as IATA BCBP:")
            parsed = parse_bcbp(raw_data)
            for key, value in parsed.items():
                print(f"  {key}: {value}")
        else:
            print("(Does not appear to be IATA BCBP format)")


if __name__ == "__main__":
    main()
