{
  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = fn: nixpkgs.lib.genAttrs systems (system: fn { pkgs = import nixpkgs { inherit system; }; });
    in
    {
      devShells = forAllSystems ({ pkgs }: {
        default = pkgs.mkShell {
          buildInputs = [ pkgs.deno ];
        };
      });
      apps = forAllSystems ({ pkgs }: {
        default = {
          type = "app";
            program = "${pkgs.writeShellScript "start-deno" ''
            exec ${pkgs.deno}/bin/deno task start "$@"
            ''}";
        };
      });
      formatter = forAllSystems ({ pkgs }: pkgs.nixpkgs-fmt);
    };
}

