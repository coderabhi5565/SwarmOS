"""Benchmarks: comparing SwarmOS configurations on the real orchestration engine.

Every benchmark trial is an ordinary run, executed by ``RunService`` through
the same graph as any other run; this package only decides *which* runs to
make, records how they were configured, and measures what their persisted
records and traces establish.
"""
