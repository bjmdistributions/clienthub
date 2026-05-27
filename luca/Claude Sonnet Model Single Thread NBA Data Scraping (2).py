import requests
from bs4 import BeautifulSoup, Comment
import time
import csv
import os
from collections import defaultdict
from urllib.parse import urljoin
from datetime import datetime
import pandas as pd
import re

class NBASeasonScraper:
    def __init__(self, start_year, end_year):
        self.start_year = start_year
        self.end_year = end_year
        self.base_url = 'https://www.basketball-reference.com'
        self.output_dir = self._create_output_directories()
        self.player_data = defaultdict(list)
        self.processed_games = set()
        
    def _create_output_directories(self):
        """Create directory structure for output files"""
        output_dir = f'basketball_stats_{self.start_year}-{self.end_year}'
        os.makedirs(output_dir, exist_ok=True)
        return output_dir

    def get_season_schedule(self, season_year):
        """Get all game URLs for a specific season"""
        game_urls = []
        
        # NBA season spans two years (except for shortened seasons)
        # Need to check both calendar years for complete season
        months = {
            str(season_year - 1): ['october', 'november', 'december'],
            str(season_year): ['january', 'february', 'march', 'april', 'may', 'june']
        }
        
        for year, year_months in months.items():
            for month in year_months:
                schedule_url = f"{self.base_url}/leagues/NBA_{season_year}_games-{month}.html"
                
                try:
                    print(f"Fetching schedule for {month.capitalize()} {year}")
                    response = requests.get(schedule_url)
                    soup = BeautifulSoup(response.content, 'html.parser')
                    
                    schedule_table = soup.find('table', {'id': 'schedule'})
                    
                    if schedule_table:
                        for row in schedule_table.find_all('tr'):
                            box_score_cell = row.find('td', {'data-stat': 'box_score_text'})
                            if box_score_cell and box_score_cell.find('a'):
                                game_url = urljoin(self.base_url, box_score_cell.find('a')['href'])
                                game_urls.append(game_url)
                    
                    # Respect rate limits between month requests
                    time.sleep(3)
                    
                except Exception as e:
                    print(f"Error fetching schedule for {month} {year}: {e}")
                    continue
        
        print(f"Found {len(game_urls)} games in the {season_year-1}-{season_year} season")
        return game_urls

    def _get_game_metadata(self, soup, season_year):
        """Extract game metadata including scores and season"""
        try:
            scorebox_meta = soup.find('div', class_='scorebox_meta')
            scorebox = soup.find('div', class_='scorebox')
            
            if not scorebox_meta or not scorebox:
                return {}

            metadata = {}
            meta_items = scorebox_meta.find_all('div')
            
            # Get basic metadata
            for item in meta_items:
                text = item.get_text(separator=' ', strip=True)
                if 'Start Time' in text:
                    metadata['Game_Time'] = text.replace('Start Time: ', '')
                elif any(x in text for x in ['Arena', 'Attendance', 'Officials', 'Game Duration']):
                    continue
                else:
                    metadata['Game_Date'] = text

            # Add season year information
            metadata['Season'] = f"{season_year-1}-{season_year}"
            
            # Get team scores
            team_divs = scorebox.find_all('div', class_='score')
            if len(team_divs) == 2:
                away_score = int(team_divs[0].text.strip())
                home_score = int(team_divs[1].text.strip())
                metadata['Away_Score'] = away_score
                metadata['Home_Score'] = home_score

            # Get overtime information
            line_score_table = soup.find('table', {'id': 'line_score'})
            if line_score_table:
                header_cells = line_score_table.find('thead').find_all('th')
                ot_count = sum(1 for cell in header_cells if cell.text.startswith('OT'))
                metadata['Overtimes'] = str(ot_count) if ot_count > 0 else ''

            return metadata

        except Exception as e:
            print(f"Error getting game metadata: {e}")
            return {}

    def process_game(self, box_score_url, season_year):
        """Process a single game's data"""
        if box_score_url in self.processed_games:
            print(f"Already processed game: {box_score_url}")
            return []
            
        try:
            print(f"\nProcessing game URL: {box_score_url}")
            response = requests.get(box_score_url)
            soup = BeautifulSoup(response.content, 'html.parser')

            # Get game metadata with season year
            game_info = self._get_game_metadata(soup, season_year)
            if not game_info:
                return []

            # Get team abbreviations and set up home/away teams
            team_info = self._get_team_info(soup)
            if not team_info:
                return []

            away_team_abbr, home_team_abbr = team_info
            
            # Determine winner
            if 'Away_Score' in game_info and 'Home_Score' in game_info:
                away_score = game_info['Away_Score']
                home_score = game_info['Home_Score']
                
                # Add point differential
                game_info['Point_Differential'] = abs(away_score - home_score)
                
                # Create a mapping of team to whether they won
                team_result = {
                    away_team_abbr: 'W' if away_score > home_score else 'L',
                    home_team_abbr: 'W' if home_score > away_score else 'L'
                }
            
            # Process player stats for both teams
            game_data = []
            for team_abbr in [away_team_abbr, home_team_abbr]:
                location = 'Home' if team_abbr == home_team_abbr else 'Away'
                
                # Get basic and advanced stats
                basic_stats = self._get_basic_stats(soup, team_abbr)
                advanced_stats = self._get_advanced_stats(soup, team_abbr)
                
                # Combine stats for each player
                for player_name, basic in basic_stats.items():
                    if player_name in advanced_stats:
                        stats = {**basic, **advanced_stats[player_name]}
                        stats.update(game_info)
                        stats['Team'] = team_abbr
                        stats['Home/Away'] = location
                        stats['Opponent'] = home_team_abbr if location == 'Away' else away_team_abbr
                        
                        # Add game result
                        stats['Game_Result'] = team_result.get(team_abbr, 'Unknown')
                        stats['Team_Score'] = home_score if location == 'Home' else away_score
                        stats['Opponent_Score'] = away_score if location == 'Home' else home_score
                        
                        game_data.append(stats)

            # Add roster information to each player's data
            roster_info = self._get_roster_information(game_data)
            for stats in game_data:
                player = stats['Player']
                if player in roster_info:
                    stats.update(roster_info[player])

            # Mark game as processed
            self.processed_games.add(box_score_url)
            
            # Add game URL to data
            for stats in game_data:
                stats['Game_URL'] = box_score_url

            return game_data

        except Exception as e:
            print(f"Error processing {box_score_url}: {e}")
            return []

    # [Other helper methods remain the same: _get_team_info, _get_basic_stats, _get_advanced_stats, _get_roster_information]

    def save_player_data(self):
        """Save all player data to CSV files"""
        print("\nSaving player data to CSV files...")
        
        for player, games in self.player_data.items():
            if not games:  # Skip if no games data
                continue
                
            # Create sanitized filename
            filename = f"{player.replace(' ', '_').replace('/', '_')}.csv"
            filepath = os.path.join(self.output_dir, filename)
            
            # Get all possible fields across all games
            fieldnames = set()
            for game in games:
                fieldnames.update(game.keys())
            
            # Sort fieldnames to ensure consistent column ordering
            fieldnames = sorted(list(fieldnames))
            
            # Write to CSV
            with open(filepath, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(games)
            
            print(f"Saved {len(games)} games for {player} to {filepath}")
            
    def _get_team_info(self, soup):
        """Extract team abbreviations from the box score page"""
        try:
            scorebox = soup.find('div', class_='scorebox')
            if not scorebox:
                return None
            
            team_links = scorebox.find_all('a', href=re.compile(r'/teams/\w+/\d{4}\.html'))
            if len(team_links) != 2:
                return None
            
            # Extract team abbreviations from the URLs
            away_team = team_links[0]['href'].split('/')[2]
            home_team = team_links[1]['href'].split('/')[2]
            
            return away_team, home_team

        except Exception as e:
            print(f"Error getting team info: {e}")
            return None

    def _get_basic_stats(self, soup, team_abbr):
        """Extract basic statistics for all players on a team"""
        try:
            # Find the basic stats table for the team
            basic_table = soup.find('table', {'id': f'box-{team_abbr}-game-basic'})
            if not basic_table:
                return {}

            players_stats = {}
            
            # Process each row in the table
            for row in basic_table.find('tbody').find_all('tr'):
                if 'thead' in row.get('class', []):  # Skip header rows
                    continue
                    
                cells = row.find_all(['th', 'td'])
                if not cells:
                    continue
                
                # Get player name
                player_name = cells[0].get_text(strip=True)
                if not player_name or player_name == 'Team Totals':
                    continue
                
                # Extract basic stats
                stats = {
                    'Player': player_name,
                    'MP': cells[1].get_text(strip=True),
                    'FG': cells[2].get_text(strip=True),
                    'FGA': cells[3].get_text(strip=True),
                    'FG%': cells[4].get_text(strip=True),
                    '3P': cells[5].get_text(strip=True),
                    '3PA': cells[6].get_text(strip=True),
                    '3P%': cells[7].get_text(strip=True),
                    'FT': cells[8].get_text(strip=True),
                    'FTA': cells[9].get_text(strip=True),
                    'FT%': cells[10].get_text(strip=True),
                    'ORB': cells[11].get_text(strip=True),
                    'DRB': cells[12].get_text(strip=True),
                    'TRB': cells[13].get_text(strip=True),
                    'AST': cells[14].get_text(strip=True),
                    'STL': cells[15].get_text(strip=True),
                    'BLK': cells[16].get_text(strip=True),
                    'TOV': cells[17].get_text(strip=True),
                    'PF': cells[18].get_text(strip=True),
                    'PTS': cells[19].get_text(strip=True)
                }
                
                players_stats[player_name] = stats

            return players_stats

        except Exception as e:
            print(f"Error getting basic stats: {e}")
            return {}

    def _get_advanced_stats(self, soup, team_abbr):
        """Extract advanced statistics for all players on a team"""
        try:
            # Find the advanced stats table in comments
            comments = soup.find_all(string=lambda text: isinstance(text, Comment))
            advanced_soup = None
            
            for comment in comments:
                if f'box-{team_abbr}-game-advanced' in comment:
                    advanced_soup = BeautifulSoup(comment, 'html.parser')
                    break
            
            if not advanced_soup:
                return {}

            advanced_table = advanced_soup.find('table', {'id': f'box-{team_abbr}-game-advanced'})
            if not advanced_table:
                return {}

            players_advanced_stats = {}
            
            # Process each row in the table
            for row in advanced_table.find('tbody').find_all('tr'):
                if 'thead' in row.get('class', []):
                    continue
                    
                cells = row.find_all(['th', 'td'])
                if not cells:
                    continue
                
                # Get player name
                player_name = cells[0].get_text(strip=True)
                if not player_name or player_name == 'Team Totals':
                    continue
                
                # Extract advanced stats
                advanced_stats = {
                    'TSA': cells[1].get_text(strip=True),
                    'TS%': cells[2].get_text(strip=True),
                    'eFG%': cells[3].get_text(strip=True),
                    'ORB%': cells[4].get_text(strip=True),
                    'DRB%': cells[5].get_text(strip=True),
                    'TRB%': cells[6].get_text(strip=True),
                    'AST%': cells[7].get_text(strip=True),
                    'STL%': cells[8].get_text(strip=True),
                    'BLK%': cells[9].get_text(strip=True),
                    'TOV%': cells[10].get_text(strip=True),
                    'USG%': cells[11].get_text(strip=True),
                    'ORtg': cells[12].get_text(strip=True),
                    'DRtg': cells[13].get_text(strip=True),
                    'BPM': cells[14].get_text(strip=True)
                }
                
                players_advanced_stats[player_name] = advanced_stats

            return players_advanced_stats

        except Exception as e:
            print(f"Error getting advanced stats: {e}")
            return {}

    def _get_roster_information(self, game_data):
        """Extract roster information for players in the game"""
        try:
            if not game_data:
                return {}
                
            roster_info = {}
            for player_stats in game_data:
                player_name = player_stats['Player']
                
                # Extract position and other info if available
                roster_info[player_name] = {
                    'Player_ID': player_name.lower().replace(' ', '_'),
                    'Position': 'N/A'  # Would need additional scraping to get actual position
                }
                
            return roster_info

        except Exception as e:
            print(f"Error getting roster information: {e}")
            return {}


    def scrape_all_seasons(self):
        """Scrape all seasons in the specified range"""
        total_seasons = self.end_year - self.start_year + 1
        
        print(f"\nStarting to scrape {total_seasons} seasons from {self.start_year-1}-{self.start_year} to {self.end_year-1}-{self.end_year}")
        
        for season_year in range(self.start_year, self.end_year + 1):
            print(f"\nProcessing {season_year-1}-{season_year} season")
            
            # Get game URLs for this season
            game_urls = self.get_season_schedule(season_year)
            total_games = len(game_urls)
            
            print(f"\nStarting to scrape {total_games} games for the {season_year-1}-{season_year} season")
            
            for i, game_url in enumerate(game_urls, 1):
                print(f"\nProcessing game {i}/{total_games}")
                game_data = self.process_game(game_url, season_year)
                
                # Add game data to player records
                for player_game_data in game_data:
                    player = player_game_data['Player']
                    self.player_data[player].append(player_game_data)
                
                # Save progress every 50 games
                if i % 50 == 0:
                    print(f"\nSaving progress after {i} games...")
                    self.save_player_data()
                
                # Respect rate limits
                time.sleep(3.25)
            
            # Save after each season
            self.save_player_data()
            print(f"\nCompleted scraping {season_year-1}-{season_year} season!")
        
        # Final save
        self.save_player_data()
        print(f"\nCompleted scraping all seasons!")
        print(f"Total players processed: {len(self.player_data)}")
        print(f"Data saved in: {self.output_dir}")

def main():
    # Specify the season year range (e.g., 2020 to 2024 for 2019-20 through 2023-24 seasons)
    start_year = 2022
    end_year = 2024
    
    # Create scraper instance
    scraper = NBASeasonScraper(start_year, end_year)
    
    # Run the scraper
    scraper.scrape_all_seasons()

if __name__ == "__main__":
    main()
