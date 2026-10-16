# Normalize email addresses before lookup

This Spring Boot service stores users in PostgreSQL. Fix `UserService.findByEmail` so lookup is case-insensitive and ignores leading or trailing whitespace. Keep the repository API unchanged. The existing regression test is the reproduction command; make it pass, then run all tests.
