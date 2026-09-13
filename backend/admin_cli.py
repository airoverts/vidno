import argparse

from auth import set_user_role
from database import initialize_database


def main():
    parser = argparse.ArgumentParser(prog="admin_cli")
    subparsers = parser.add_subparsers(dest="command", required=True)
    role_parser = subparsers.add_parser("set-role")
    role_parser.add_argument("email")
    role_parser.add_argument("role", choices=("client", "admin"))
    args = parser.parse_args()

    initialize_database()
    row = set_user_role(args.email, args.role)
    if not row:
        parser.error("user not found")
    print(f"{row['email']}: {row['role']}")


if __name__ == "__main__":
    main()
