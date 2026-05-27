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

    def _get_team_players(self, basic_stats):
        """Extract list of players from basic stats"""
        return [player for player in basic_stats.keys()]

    def _get_sorted_players_by_minutes(self, team_stats):
        """
        Sort players by minutes played and return list of tuples (player_name, minutes)
        """
        try:
            player_minutes = []
            for player, stats in team_stats.items():
                minutes = stats.get('MP', '0:00')
                
                # Convert minutes from "MM:SS" format to float
                if ':' in minutes:
                    try:
                        mins, secs = minutes.split(':')
                        minutes_float = float(mins) + float(secs)/60
                    except ValueError:
                        minutes_float = 0.0
                else:
                    try:
                        minutes_float = float(minutes)
                    except ValueError:
                        minutes_float = 0.0
                
                player_minutes.append((player, minutes, minutes_float))
            
            # Sort by minutes played (float value) in descending order
            sorted_players = sorted(player_minutes, key=lambda x: x[2], reverse=True)
            
            # Return only player name and original minutes string
            return [(p[0], p[1]) for p in sorted_players]
        except Exception as e:
            print(f"Error sorting players by minutes: {e}")
            return []

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
                print("Failed to get game metadata")
                return []

            # Get team abbreviations and set up home/away teams
            team_info = self._get_team_info(soup)
            if not team_info:
                print("Failed to get team info")
                return []

            away_team_abbr, home_team_abbr = team_info
            
            # Get basic stats for both teams first to extract complete rosters
            away_basic_stats = self._get_basic_stats(soup, away_team_abbr)
            home_basic_stats = self._get_basic_stats(soup, home_team_abbr)
            
            if not away_basic_stats or not home_basic_stats:
                print("Failed to get basic stats for one or both teams")
                return []
                
            # Get advanced stats for both teams
            away_advanced_stats = self._get_advanced_stats(soup, away_team_abbr)
            home_advanced_stats = self._get_advanced_stats(soup, home_team_abbr)
            
            # Process game if we have scores
            processed_count = 0
            if 'Away_Score' in game_info and 'Home_Score' in game_info:
                away_score = game_info['Away_Score']
                home_score = game_info['Home_Score']
                game_info['Point_Differential'] = abs(away_score - home_score)
                
                # Create a mapping of team to whether they won
                team_result = {
                    away_team_abbr: 'W' if away_score > home_score else 'L',
                    home_team_abbr: 'W' if home_score > away_score else 'L'
                }
            
                # Process player stats for both teams
                team_data = {
                    away_team_abbr: {
                        'location': 'Away',
                        'basic_stats': away_basic_stats,
                        'advanced_stats': away_advanced_stats,
                        'teammates': self._get_sorted_players_by_minutes(away_basic_stats),
                        'opponents': self._get_sorted_players_by_minutes(home_basic_stats),
                        'opponent_team': home_team_abbr,
                        'team_score': away_score,
                        'opponent_score': home_score,
                        'opponent_basic_stats': home_basic_stats
                    },
                    home_team_abbr: {
                        'location': 'Home',
                        'basic_stats': home_basic_stats,
                        'advanced_stats': home_advanced_stats,
                        'teammates': self._get_sorted_players_by_minutes(home_basic_stats),
                        'opponents': self._get_sorted_players_by_minutes(away_basic_stats),
                        'opponent_team': away_team_abbr,
                        'team_score': home_score,
                        'opponent_score': away_score,
                        'opponent_basic_stats': away_basic_stats
                    }
                }

                # Process each team's players
                for team_abbr, team_info_dict in team_data.items():
                    team_basic_stats = team_info_dict['basic_stats']
                    team_advanced_stats = team_info_dict['advanced_stats']
                    
                    for player_name, basic in team_basic_stats.items():
                        player_stats = basic.copy()
                        
                        # Add advanced stats if available
                        if team_advanced_stats and player_name in team_advanced_stats:
                            player_stats.update(team_advanced_stats[player_name])
                        
                        # Add scoring stats
                        player_stats.update(self._get_scoring_stats(player_stats))
                        
                        # Add impact stats
                        player_stats.update(self._get_impact_stats(player_stats, player_stats))
                        
                        # Add game and team information
                        player_stats.update(game_info)
                        player_stats.update({
                            'Team': team_abbr,
                            'Home/Away': team_info_dict['location'],
                            'Opponent': team_info_dict['opponent_team'],
                            'Game_Result': team_result.get(team_abbr, 'Unknown'),
                            'Team_Score': team_info_dict['team_score'],
                            'Opponent_Score': team_info_dict['opponent_score'],
                            'Game_URL': box_score_url
                        })
                        
                        # Add teammate information - exclude current player
                        teammates = [t for t in team_info_dict['teammates'] if t[0] != player_name]
                        for i, (teammate, minutes) in enumerate(teammates[:15], 1):  # Limit to 15 teammates
                            player_stats[f'Teammate_{i}'] = teammate
                            player_stats[f'Teammate_{i}_MP'] = minutes
                        
                        # Fill remaining teammate slots with empty values if less than 15 teammates
                        for i in range(len(teammates) + 1, 16):
                            player_stats[f'Teammate_{i}'] = ''
                            player_stats[f'Teammate_{i}_MP'] = ''
                        
                        # Add opponent information
                        opponents = team_info_dict['opponents'][:15]  # Limit to 15 opponents
                        for i, (opponent, minutes) in enumerate(opponents, 1):
                            player_stats[f'Opponent_{i}'] = opponent
                            player_stats[f'Opponent_{i}_MP'] = minutes
                        
                        # Fill remaining opponent slots with empty values if less than 15 opponents
                        for i in range(len(opponents) + 1, 16):
                            player_stats[f'Opponent_{i}'] = ''
                            player_stats[f'Opponent_{i}_MP'] = ''
                        
                        # Add to player_data dictionary
                        self.player_data[player_name].append(player_stats)
                        processed_count += 1

            # Mark game as processed
            self.processed_games.add(box_score_url)
            
            print(f"Successfully processed {processed_count} player records")
            return []

        except Exception as e:
            print(f"Error processing {box_score_url}: {e}")
            return []
        
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
            basic_table = soup.find('table', {'id': f'box-{team_abbr}-game-basic'})
            if not basic_table:
                return {}

            players_stats = {}
            stat_columns = ['MP', 'FG', 'FGA', 'FG%', '3P', '3PA', '3P%', 'FT', 'FTA', 'FT%', 
                           'ORB', 'DRB', 'TRB', 'AST', 'STL', 'BLK', 'TOV', 'PF', 'PTS']
            
            for row in basic_table.find('tbody').find_all('tr'):
                if 'thead' in row.get('class', []) or len(row.find_all(['th', 'td'])) < 20:
                    continue
                
                cells = row.find_all(['th', 'td'])
                player_name = cells[0].get_text(strip=True)
                
                if not player_name or player_name == 'Team Totals':
                    continue
                
                try:
                    stats = {'Player': player_name}
                    stats.update({stat: cells[i+1].get_text(strip=True) 
                                for i, stat in enumerate(stat_columns)})
                    players_stats[player_name] = stats
                except Exception as e:
                    print(f"Error processing stats for {player_name}: {e}")
                    continue

            return players_stats

        except Exception as e:
            print(f"Error getting basic stats: {e}")
            return {}

    def _get_scoring_stats(self, basic_stats):
        """Calculate additional scoring statistics from basic stats"""
        try:
            # Convert all needed stats to numbers at once
            stats_to_convert = {'FG', 'FGA', '3P', '3PA', 'FT', 'FTA', 'PTS'}
            values = {key: float(basic_stats.get(key, '0') or '0') 
                     for key in stats_to_convert}
            
            # Calculate all stats at once
            fg, fga = values['FG'], values['FGA']
            fg3, fg3a = values['3P'], values['3PA']
            ft, fta = values['FT'], values['FTA']
            pts = values['PTS']
            
            fg2 = fg - fg3
            fg2a = fga - fg3a
            
            stats = {
                'FG2': fg2,
                'FG2A': fg2a,
                'FG2%': f"{(fg2 / fg2a * 100):.1f}" if fg2a > 0 else '',
                'PTS_2P': fg2 * 2,
                'PTS_3P': fg3 * 3,
                'PTS_FT': ft
            }
            
            # Calculate percentages if there are points
            if pts > 0:
                stats.update({
                    'PTS_2P_Pct': f"{(stats['PTS_2P'] / pts * 100):.1f}",
                    'PTS_3P_Pct': f"{(stats['PTS_3P'] / pts * 100):.1f}",
                    'PTS_FT_Pct': f"{(stats['PTS_FT'] / pts * 100):.1f}"
                })
            else:
                stats.update({
                    'PTS_2P_Pct': '',
                    'PTS_3P_Pct': '',
                    'PTS_FT_Pct': ''
                })
            
            # Calculate rates if attempts exist
            if fga > 0:
                stats.update({
                    'FTr': f"{(fta / fga * 100):.3f}",
                    '3PAr': f"{(fg3a / fga * 100):.3f}"
                })
            else:
                stats.update({
                    'FTr': '',
                    '3PAr': ''
                })
            
            return stats
            
        except Exception as e:
            print(f"Error calculating scoring stats: {e}")
            return {}

    def _get_impact_stats(self, basic_stats, advanced_stats):
        """Calculate additional impact statistics"""
        try:
            # Convert all needed stats to numbers at once
            stats_to_convert = {'AST', 'TOV', 'STL', 'BLK', 'ORB', 'DRB'}
            values = {key: float(basic_stats.get(key, '0') or '0') 
                     for key in stats_to_convert}
            
            ast, tov = values['AST'], values['TOV']
            stl, blk = values['STL'], values['BLK']
            orb, drb = values['ORB'], values['DRB']
            
            # Calculate all stats at once
            trb = orb + drb
            stats = {
                'AST/TOV': f"{(ast / tov):.2f}" if tov > 0 else '',
                'Stocks': stl + blk,
                'TRB': trb
            }
            
            # Calculate rebound percentages if there are rebounds
            if trb > 0:
                stats.update({
                    'ORB_Pct_of_TRB': f"{(orb / trb * 100):.1f}",
                    'DRB_Pct_of_TRB': f"{(drb / trb * 100):.1f}"
                })
            else:
                stats.update({
                    'ORB_Pct_of_TRB': '',
                    'DRB_Pct_of_TRB': ''
                })
            
            return stats
            
        except Exception as e:
            print(f"Error calculating impact stats: {e}")
            return {}

    def _get_advanced_stats(self, soup, team_abbr):
        """Extract advanced statistics for all players on a team"""
        try:
            # Find advanced stats table in comments more efficiently
            advanced_soup = None
            for comment in soup.find_all(string=lambda text: 
                isinstance(text, Comment) and f'box-{team_abbr}-game-advanced' in text):
                advanced_soup = BeautifulSoup(comment, 'html.parser')
                break
            
            if not advanced_soup:
                return {}

            advanced_table = advanced_soup.find('table', {'id': f'box-{team_abbr}-game-advanced'})
            if not advanced_table:
                return {}

            # Get header information once
            header_row = advanced_table.find('thead').find_all('th')
            stat_info = []
            for header in header_row:
                stat_name = header.get_text(strip=True)
                if stat_name and stat_name not in ["Starters", "Reserves"]:
                    stat_info.append({
                        'name': stat_name,
                        'description': header.get('data-tip', stat_name).strip()
                    })

            players_advanced_stats = {}
            
            # Process each player row
            for row in advanced_table.find('tbody').find_all('tr'):
                if 'thead' in row.get('class', []):
                    continue
                    
                cells = row.find_all(['th', 'td'])
                if not cells:
                    continue
                
                player_name = cells[0].get_text(strip=True)
                if not player_name or player_name == 'Team Totals':
                    continue
                
                advanced_stats = {}
                
                # Process all stats at once
                for i, cell in enumerate(cells[1:], 1):
                    if i < len(stat_info):
                        stat = stat_info[i]
                        value = cell.get_text(strip=True)
                        
                        stat_name = stat['name']
                        advanced_stats[stat_name] = value
                        advanced_stats[f"{stat_name}_Description"] = stat['description']
                        
                        # Handle percentage conversions
                        if '%' in stat_name and value:
                            try:
                                pct_value = float(value.strip('%'))
                                advanced_stats[f"{stat_name}_Decimal"] = pct_value / 100
                            except ValueError:
                                pass
                
                # Calculate composite stats in batch
                try:
                    if all(key in advanced_stats for key in ('TS%', 'USG%')):
                        ts_pct = float(advanced_stats['TS%'].strip('%')) / 100
                        usg_pct = float(advanced_stats['USG%'].strip('%')) / 100
                        advanced_stats['Scoring_Efficiency'] = ts_pct * usg_pct
                    
                    if all(key in advanced_stats for key in ('ORtg', 'DRtg')):
                        ortg = float(advanced_stats['ORtg'])
                        drtg = float(advanced_stats['DRtg'])
                        advanced_stats['Net_Rating'] = ortg - drtg
                except (ValueError, KeyError):
                    pass
                
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

    def save_player_data(self):
        """Save all player data to CSV files more efficiently"""
        print("\nSaving player data to CSV files...")
        player_count = len(self.player_data)
        print(f"Number of players to save: {player_count}")
        
        # Get all possible fields once
        all_fieldnames = set()
        for games in self.player_data.values():
            for game in games:
                all_fieldnames.update(game.keys())
        
        # Sort fieldnames once
        sorted_fieldnames = sorted(all_fieldnames)
        
        for player, games in self.player_data.items():
            if not games:
                continue
            
            print(f"Saving data for {player} with {len(games)} games")
            
            filename = f"{player.replace(' ', '_').replace('/', '_')}.csv"
            filepath = os.path.join(self.output_dir, filename)
            
            try:
                with open(filepath, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.DictWriter(f, fieldnames=sorted_fieldnames)
                    writer.writeheader()
                    writer.writerows(games)
                
                print(f"Successfully saved {len(games)} games for {player} to {filepath}")
            except Exception as e:
                print(f"Error saving data for {player}: {e}")

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
                self.process_game(game_url, season_year)
                
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
    start_year = 2014
    end_year = 2024
    
    # Create scraper instance
    scraper = NBASeasonScraper(start_year, end_year)
    
    # Run the scraper
    scraper.scrape_all_seasons()

if __name__ == "__main__":
    main()
