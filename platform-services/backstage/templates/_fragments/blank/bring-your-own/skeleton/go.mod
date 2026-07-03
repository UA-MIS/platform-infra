// go.mod — this placeholder builds with ONLY the Go standard library, so there are no
// `require` lines and the build downloads NO modules (network-free, works behind the
// platform's :443-only runner egress). Replace this with your own module + deps as you grow.
module ${{ values.appName }}

go 1.23
