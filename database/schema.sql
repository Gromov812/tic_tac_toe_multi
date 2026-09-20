CREATE TABLE IF NOT EXISTS players (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  external_id VARCHAR(128) NOT NULL,
  display_name VARCHAR(24) NOT NULL DEFAULT 'Игрок',
  rating INT NOT NULL DEFAULT 1200,
  games_played INT UNSIGNED NOT NULL DEFAULT 0,
  wins INT UNSIGNED NOT NULL DEFAULT 0,
  losses INT UNSIGNED NOT NULL DEFAULT 0,
  draws INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_players_external_id (external_id),
  KEY idx_players_rating (rating)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS matches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_code VARCHAR(12) NOT NULL,
  player_x_id BIGINT UNSIGNED NOT NULL,
  player_o_id BIGINT UNSIGNED NOT NULL,
  winner ENUM('X', 'O', 'draw') NULL,
  status ENUM('started', 'finished', 'abandoned') NOT NULL DEFAULT 'started',
  moves_count INT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_matches_room (room_code),
  KEY idx_matches_started (started_at),
  CONSTRAINT fk_matches_player_x FOREIGN KEY (player_x_id) REFERENCES players(id),
  CONSTRAINT fk_matches_player_o FOREIGN KEY (player_o_id) REFERENCES players(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_moves (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  match_id BIGINT UNSIGNED NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  symbol ENUM('X', 'O') NOT NULL,
  board_index TINYINT UNSIGNED NULL,
  cell_index TINYINT UNSIGNED NULL,
  state_json JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_moves_match (match_id),
  CONSTRAINT fk_moves_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_moves_player FOREIGN KEY (player_id) REFERENCES players(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  player_id BIGINT UNSIGNED NOT NULL,
  scope ENUM('global', 'room') NOT NULL,
  room_code VARCHAR(12) NULL,
  message VARCHAR(240) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_chat_scope_created (scope, created_at),
  KEY idx_chat_room_created (room_code, created_at),
  CONSTRAINT fk_chat_player FOREIGN KEY (player_id) REFERENCES players(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS friendships (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  requester_id BIGINT UNSIGNED NOT NULL,
  addressee_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending', 'accepted', 'declined') NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_friendship_pair (requester_id, addressee_id),
  KEY idx_friendship_addressee (addressee_id, status),
  CONSTRAINT fk_friendship_requester FOREIGN KEY (requester_id) REFERENCES players(id) ON DELETE CASCADE,
  CONSTRAINT fk_friendship_addressee FOREIGN KEY (addressee_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_invites (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sender_id BIGINT UNSIGNED NOT NULL,
  recipient_id BIGINT UNSIGNED NOT NULL,
  room_code VARCHAR(12) NOT NULL,
  status ENUM('pending', 'accepted', 'declined', 'expired') NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_invites_recipient (recipient_id, status, created_at),
  CONSTRAINT fk_invite_sender FOREIGN KEY (sender_id) REFERENCES players(id) ON DELETE CASCADE,
  CONSTRAINT fk_invite_recipient FOREIGN KEY (recipient_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
