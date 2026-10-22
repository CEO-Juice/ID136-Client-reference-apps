"""Minimal console logging. Redirect output to a file from your scheduler if you want to keep it.

PRODUCTION NOTE: use the logging module with a rotating file handler, alert on errors, and never
log the settings or request headers: they hold secrets.
"""
from datetime import datetime


def _write(level, message):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {level:<5} {message}", flush=True)


def info(message):
    _write("INFO", message)


def warn(message):
    _write("WARN", message)


def error(message):
    _write("ERROR", message)
