ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"
require "minitest/mock" # provides Object#stub (used by the DB-degrade test)

module ActiveSupport
  class TestCase
    # SQLite test DB (config/database.yml `test:`) — run serially to keep one DB file.
    # No fixtures are defined; the suite creates its own records.
  end
end
