ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)

require "bundler/setup" # Set up gems listed in the Gemfile.

# NOTE: bootsnap is intentionally NOT used. The platform pod runs with a read-only root
# filesystem (and no writable tmp mount), so bootsnap's compile cache under tmp/cache
# cannot be written at runtime. Dropping it keeps the container write-free; the small
# boot-time cost is acceptable for this starter.
