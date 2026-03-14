#!/usr/bin/env python3
"""
Extract attendee/lead information from an event platform screen recording.

Usage:
    python3 extract_video_attendees.py <video_file> [--output leads.csv] [--interval 0.5]

The script:
1. Samples frames from the video at regular intervals
2. Uses EasyOCR to read text from each frame
3. Parses attendee info (name, title, company, etc.)
4. Deduplicates across all frames
5. Outputs a clean CSV file
"""

import argparse
import csv
import os
import re
import sys
from dataclasses import dataclass
from difflib import SequenceMatcher

try:
    import cv2
except ImportError:
    sys.exit("Error: opencv-python-headless not installed. Run: pip3 install -r requirements.txt")

try:
    import easyocr
except ImportError:
    sys.exit("Error: easyocr not installed. Run: pip3 install -r requirements.txt")


@dataclass
class Attendee:
    name: str
    title: str = ""
    company: str = ""
    location: str = ""
    extra: str = ""
    frame_number: int = 0

    def key(self):
        return self.name.strip().lower()

    def merge(self, other):
        """Merge in fields from another record for the same person."""
        if not self.title and other.title:
            self.title = other.title
        if not self.company and other.company:
            self.company = other.company
        if not self.location and other.location:
            self.location = other.location
        if not self.extra and other.extra:
            self.extra = other.extra


def similar(a: str, b: str, threshold: float = 0.85) -> bool:
    """Check if two strings are similar enough to be considered the same person."""
    if not a or not b:
        return False
    return SequenceMatcher(None, a.lower(), b.lower()).ratio() >= threshold


def is_likely_name(text: str) -> bool:
    """Heuristic: check if a line looks like a person's name."""
    text = text.strip()
    if not text or len(text) < 3 or len(text) > 80:
        return False
    skip_patterns = [
        r'^\d+$',
        r'^https?://',
        r'^\W+$',
        r'^(attendees?|participants?|guests?|viewers?|registered|online|offline)',
        r'^(search|filter|sort|show|hide|view|page|next|prev)',
        r'^(am|pm|\d{1,2}:\d{2})',
        r'^\d{1,2}[/-]\d{1,2}',
    ]
    for pattern in skip_patterns:
        if re.match(pattern, text, re.IGNORECASE):
            return False
    # Reject if it looks like a title/company (checked before name)
    if is_likely_title_or_company(text):
        return False
    # Reject if it looks like a location
    if extract_location(text):
        return False
    words = text.split()
    if len(words) < 2 or len(words) > 6:
        return False
    letter_ratio = sum(1 for c in text if c.isalpha()) / max(len(text), 1)
    return letter_ratio > 0.7


def is_likely_title_or_company(text: str) -> bool:
    """Heuristic: check if a line looks like a job title or company."""
    text = text.strip()
    if not text or len(text) < 2 or len(text) > 120:
        return False
    title_keywords = [
        'ceo', 'cto', 'coo', 'cfo', 'cmo', 'vp', 'director', 'manager',
        'engineer', 'developer', 'designer', 'analyst', 'consultant',
        'founder', 'co-founder', 'partner', 'lead', 'head', 'chief',
        'specialist', 'coordinator', 'associate', 'intern', 'executive',
        'president', 'officer', 'advisor', 'strategist', 'architect',
        'operations', 'marketing', 'sales', 'product', 'growth',
        'revenue', 'account', 'business', 'customer', 'success',
        'inc', 'llc', 'ltd', 'corp', 'company', 'group', 'agency',
        'solutions', 'technologies', 'software', 'digital', 'media',
        'at ', '@ ', '|',
    ]
    lower = text.lower()
    return any(kw in lower for kw in title_keywords)


def extract_location(text: str) -> bool:
    """Check if text looks like a location."""
    location_patterns = [
        r'\b[A-Z][a-z]+,\s*[A-Z]{2}\b',
        r'\b[A-Z][a-z]+,\s*[A-Z][a-z]+\b',
        r'\b(remote|virtual|online|hybrid)\b',
        r'\b(usa|uk|india|canada|australia|germany|france)\b',
    ]
    for pattern in location_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            return True
    return False


def group_ocr_results_into_lines(results):
    """Group EasyOCR bounding-box results into logical lines by Y-coordinate proximity."""
    if not results:
        return []

    entries = []
    for (bbox, text, conf) in results:
        if conf < 0.3:
            continue
        top_y = min(p[1] for p in bbox)
        left_x = min(p[0] for p in bbox)
        height = max(p[1] for p in bbox) - top_y
        entries.append({'text': text.strip(), 'y': top_y, 'x': left_x, 'h': height})

    if not entries:
        return []

    entries.sort(key=lambda e: (e['y'], e['x']))

    lines = []
    current_line = [entries[0]]
    for entry in entries[1:]:
        prev = current_line[-1]
        y_threshold = max(prev['h'] * 0.5, 10)
        if abs(entry['y'] - prev['y']) <= y_threshold:
            current_line.append(entry)
        else:
            current_line.sort(key=lambda e: e['x'])
            line_text = ' '.join(e['text'] for e in current_line)
            lines.append(line_text)
            current_line = [entry]

    if current_line:
        current_line.sort(key=lambda e: e['x'])
        line_text = ' '.join(e['text'] for e in current_line)
        lines.append(line_text)

    return lines


def parse_attendees_from_lines(lines: list, frame_number: int) -> list:
    """Parse grouped OCR lines into attendee records."""
    attendees = []
    i = 0

    while i < len(lines):
        line = lines[i]

        if is_likely_name(line):
            attendee = Attendee(name=line, frame_number=frame_number)

            for j in range(1, min(4, len(lines) - i)):
                next_line = lines[i + j]

                if is_likely_name(next_line):
                    break

                if is_likely_title_or_company(next_line):
                    if '@' in next_line or '|' in next_line or ' at ' in next_line.lower():
                        parts = re.split(r'\s*[@|]\s*|\s+at\s+', next_line, maxsplit=1)
                        if len(parts) == 2:
                            attendee.title = parts[0].strip()
                            attendee.company = parts[1].strip()
                        else:
                            attendee.title = next_line
                    elif not attendee.title:
                        attendee.title = next_line
                    elif not attendee.company:
                        attendee.company = next_line
                elif extract_location(next_line):
                    attendee.location = next_line
                elif attendee.title and not attendee.company and not is_likely_name(next_line):
                    # Line after a title is likely the company name
                    attendee.company = next_line
                elif next_line and not attendee.extra:
                    attendee.extra = next_line

            attendees.append(attendee)
        i += 1

    return attendees


def deduplicate_attendees(all_attendees: list) -> list:
    """Deduplicate attendees by fuzzy name matching and merge fields."""
    unique = {}

    for att in all_attendees:
        key = att.key()
        if not key:
            continue

        if key in unique:
            unique[key].merge(att)
            continue

        matched = False
        for existing_key in list(unique.keys()):
            if similar(key, existing_key):
                unique[existing_key].merge(att)
                matched = True
                break

        if not matched:
            unique[key] = att

    return sorted(unique.values(), key=lambda a: a.name.lower())


def preprocess_frame(frame):
    """Preprocess a video frame for better OCR accuracy."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.convertScaleAbs(gray, alpha=1.5, beta=20)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    h, w = thresh.shape
    if w < 1920:
        scale = 1920 / w
        thresh = cv2.resize(thresh, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return thresh


def extract_frames(video_path: str, interval_sec: float = 0.5):
    """Extract frames from video at given interval."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        sys.exit(f"Error: Cannot open video file: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0
    frame_interval = max(1, int(fps * interval_sec))

    print(f"Video: {os.path.basename(video_path)}")
    print(f"Duration: {duration:.1f}s | FPS: {fps:.1f} | Total frames: {total_frames}")
    print(f"Sampling every {interval_sec}s ({frame_interval} frames)")
    print()

    frame_num = 0
    sampled = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_num % frame_interval == 0:
            sampled += 1
            yield frame_num, frame
            timestamp = frame_num / fps if fps > 0 else 0
            progress = (frame_num / total_frames * 100) if total_frames > 0 else 0
            print(f"\rProcessing: frame {frame_num}/{total_frames} "
                  f"({progress:.0f}%) @ {timestamp:.1f}s — "
                  f"{sampled} frames sampled", end="", flush=True)

        frame_num += 1

    cap.release()
    print(f"\nDone sampling. {sampled} frames processed.")


def process_video(video_path: str, output_path: str, interval: float = 0.5):
    """Main processing pipeline."""
    print("Initializing EasyOCR (first run downloads model ~100MB)...")
    reader = easyocr.Reader(['en'], gpu=False)
    print("OCR engine ready.\n")

    all_attendees = []

    for frame_num, frame in extract_frames(video_path, interval):
        processed = preprocess_frame(frame)

        results = reader.readtext(processed)
        lines = group_ocr_results_into_lines(results)
        attendees = parse_attendees_from_lines(lines, frame_num)
        all_attendees.extend(attendees)

    print(f"\nRaw detections: {len(all_attendees)}")

    unique = deduplicate_attendees(all_attendees)
    print(f"Unique attendees after dedup: {len(unique)}")

    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Name', 'Title', 'Company', 'Location', 'Extra Info'])
        for att in unique:
            writer.writerow([att.name, att.title, att.company, att.location, att.extra])

    print(f"\nOutput saved to: {output_path}")
    print(f"Total leads extracted: {len(unique)}")

    return unique


def main():
    parser = argparse.ArgumentParser(
        description='Extract attendee/lead info from event platform screen recordings'
    )
    parser.add_argument('video', help='Path to the video file')
    parser.add_argument('--output', '-o', default='leads.csv',
                        help='Output CSV file path (default: leads.csv)')
    parser.add_argument('--interval', '-i', type=float, default=0.5,
                        help='Frame sampling interval in seconds (default: 0.5)')

    args = parser.parse_args()

    if not os.path.isfile(args.video):
        sys.exit(f"Error: Video file not found: {args.video}")

    process_video(args.video, args.output, args.interval)


if __name__ == '__main__':
    main()
